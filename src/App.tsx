import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl, { type ExpressionSpecification, type GeoJSONSource } from "maplibre-gl";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import "maplibre-gl/dist/maplibre-gl.css";
import "./urbanity-ui.css";
import "./App.css";

type Sex = "total" | "male" | "female";
type DisplayMode = Sex | "difference";
type RegionRates = Record<string, Record<string, Record<string, number | null>>>;
type RegionPopulations = Record<string, Record<string, Record<string, number | null>>>;

interface RateData {
  metadata: {
    year: number;
    source: string;
    sourceUrl: string;
    denominator: string;
    nationality: string;
    ageGroups: { id: string; label: string }[];
    sexes: { id: Sex; label: string }[];
  };
  rates: RegionRates;
  populations: RegionPopulations;
}

interface MunicipalityProperties {
  N03_001?: string | null;
  N03_003?: string | null;
  N03_004?: string | null;
  N03_005?: string | null;
  N03_007?: string | number | null;
  [key: string]: unknown;
}

type MunicipalityFeature = Feature<Geometry, MunicipalityProperties>;
type MunicipalityCollection = FeatureCollection<Geometry, MunicipalityProperties>;

interface RegionSummary {
  name: string;
  prefecture: string;
  rate: number | null;
  nationalRate: number | null;
  population: number | null;
  malePopulation: number | null;
  femalePopulation: number | null;
}

const INITIAL_AGE = "30-34";
const INITIAL_SELECTED_CODE = "13102";
const RATE_COLOR_STOPS: [number, string][] = [
  [0, "#2166ac"],
  [25, "#67a9cf"],
  [50, "#fff4d6"],
  [75, "#ef8a62"],
  [100, "#b2182b"],
];
const DIFFERENCE_COLOR_STOPS: [number, string][] = [
  [-25, "#2166ac"],
  [-12.5, "#67a9cf"],
  [0, "#fff4d6"],
  [12.5, "#ef8a62"],
  [25, "#b2182b"],
];
const NO_DATA_COLOR = "#9ca3af";

function displayName(properties: MunicipalityProperties): string {
  const city = String(properties.N03_004 ?? "");
  const ward = String(properties.N03_005 ?? "");
  const legacyCity = String(properties.N03_003 ?? "");
  if (ward) return city + ward;
  return city || legacyCity || "名称不明";
}

function featureBounds(feature: MunicipalityFeature): maplibregl.LngLatBounds | null {
  if (!("coordinates" in feature.geometry)) return null;
  const bounds = new maplibregl.LngLatBounds();
  let found = false;
  const visit = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
      bounds.extend([value[0], value[1]]);
      found = true;
      return;
    }
    value.forEach(visit);
  };
  visit(feature.geometry.coordinates);
  return found ? bounds : null;
}

function asMunicipalityCollection(value: unknown): MunicipalityCollection {
  const collection = value as MunicipalityCollection;
  if (collection?.type !== "FeatureCollection" || !Array.isArray(collection.features)) {
    throw new Error("市区町村の境界データを読み込めませんでした。");
  }
  return collection;
}

function asRateData(value: unknown): RateData {
  const data = value as RateData;
  if (!data?.metadata?.ageGroups || !data?.rates?.total || !data?.populations?.total) {
    throw new Error("未婚率データを読み込めませんでした。");
  }
  return data;
}

function withRates(
  collection: MunicipalityCollection,
  rates: Record<string, number | null>,
): MunicipalityCollection {
  return {
    ...collection,
    features: collection.features.map((feature) => {
      const rawCode = feature.properties?.N03_007;
      const code = rawCode === undefined || rawCode === null
        ? ""
        : String(rawCode).trim().padStart(5, "0");
      const unmarriedRate = code ? rates[code] ?? null : null;
      return {
        ...feature,
        properties: {
          ...feature.properties,
          municipalityCode: code || null,
          unmarriedRate,
          mapValue: unmarriedRate,
        },
      };
    }),
  };
}

function colorStopsFor(displayMode: DisplayMode): [number, string][] {
  return displayMode === "difference" ? DIFFERENCE_COLOR_STOPS : RATE_COLOR_STOPS;
}

function municipalityFillColor(displayMode: DisplayMode): ExpressionSpecification {
  return [
    "case",
    ["==", ["get", "mapValue"], null],
    NO_DATA_COLOR,
    [
      "interpolate",
      ["linear"],
      ["get", "mapValue"],
      ...colorStopsFor(displayMode).flat(),
    ],
  ];
}

function interpolateColor(value: number, stops: [number, string][]): string {
  const minValue = stops[0][0];
  const maxValue = stops[stops.length - 1][0];
  const clampedValue = Math.max(minValue, Math.min(maxValue, value));
  const upperStopIndex = stops.findIndex(([stop]) => clampedValue <= stop);
  if (upperStopIndex <= 0) return stops[0][1];

  const [lowerValue, lowerColor] = stops[upperStopIndex - 1];
  const [upperValue, upperColor] = stops[upperStopIndex];
  const progress = (clampedValue - lowerValue) / (upperValue - lowerValue);
  const channels = [1, 3, 5].map((offset) => {
    const lowerChannel = Number.parseInt(lowerColor.slice(offset, offset + 2), 16);
    const upperChannel = Number.parseInt(upperColor.slice(offset, offset + 2), 16);
    return Math.round(lowerChannel + (upperChannel - lowerChannel) * progress)
      .toString(16)
      .padStart(2, "0");
  });
  return `#${channels.join("")}`;
}

function valueColor(value: number | null, displayMode: DisplayMode): string {
  if (value === null) return "#6b7280";
  return interpolateColor(value, colorStopsFor(displayMode));
}

function formatPopulation(value: number | null): string {
  return value === null ? "—" : `${value.toLocaleString("ja-JP")}人`;
}

function App() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [collection, setCollection] = useState<MunicipalityCollection | null>(null);
  const [rateData, setRateData] = useState<RateData | null>(null);
  const [selectedCode, setSelectedCode] = useState<string | null>(INITIAL_SELECTED_CODE);
  const [displayMode, setDisplayMode] = useState<DisplayMode>("total");
  const [age, setAge] = useState(INITIAL_AGE);
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const featureByCode = useMemo(() => {
    const index = new Map<string, MunicipalityFeature>();
    for (const feature of collection?.features ?? []) {
      const code = String(feature.properties?.N03_007 ?? "").trim().padStart(5, "0");
      if (code) index.set(code, feature);
    }
    return index;
  }, [collection]);

  const currentRates = useMemo<Record<string, number | null>>(() => {
    if (!rateData) return {};
    if (displayMode !== "difference") return rateData.rates[displayMode]?.[age] ?? {};

    const maleRates = rateData.rates.male?.[age] ?? {};
    const femaleRates = rateData.rates.female?.[age] ?? {};
    const codes = new Set([...Object.keys(maleRates), ...Object.keys(femaleRates)]);
    return Object.fromEntries([...codes].map((code) => {
      const maleRate = maleRates[code];
      const femaleRate = femaleRates[code];
      return [code, maleRate == null || femaleRate == null ? null : maleRate - femaleRate];
    }));
  }, [age, displayMode, rateData]);
  const nationalRate = currentRates["00000"] ?? null;
  const selectedFeature = selectedCode ? featureByCode.get(selectedCode) : undefined;
  const selectedSummary: RegionSummary | null = selectedFeature && selectedCode
      ? {
        name: displayName(selectedFeature.properties ?? {}),
        prefecture: String(selectedFeature.properties?.N03_001 ?? ""),
        rate: currentRates[selectedCode] ?? null,
        nationalRate,
        population: rateData?.populations[displayMode === "difference" ? "male" : displayMode]?.[age]?.[selectedCode] ?? null,
        malePopulation: rateData?.populations.male?.[age]?.[selectedCode] ?? null,
        femalePopulation: rateData?.populations.female?.[age]?.[selectedCode] ?? null,
      }
    : null;

  const searchResults = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("ja-JP");
    if (!query || !collection) return [];
    return collection.features
      .filter((feature) => {
        const properties = feature.properties ?? {};
        const name = displayName(properties);
        const prefecture = String(properties.N03_001 ?? "");
        const code = String(properties.N03_007 ?? "");
        return `${prefecture}${name}${code}`.toLocaleLowerCase("ja-JP").includes(query);
      })
      .slice(0, 8);
  }, [collection, search]);

  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return;
    let cancelled = false;
    const map = new maplibregl.Map({
      container: mapContainer.current,
      attributionControl: false,
      dragRotate: false,
      touchPitch: false,
      style: {
        version: 8,
        sources: {
          "gsi-pale": {
            type: "raster",
            tiles: ["https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png"],
            tileSize: 256,
            attribution:
              '地図: <a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noreferrer">国土地理院</a>　境界: <a href="https://nlftp.mlit.go.jp/ksj/" target="_blank" rel="noreferrer">国土数値情報</a>',
            maxzoom: 18,
          },
        },
        layers: [{ id: "gsi-pale-layer", type: "raster", source: "gsi-pale" }],
      },
      center: [137, 38],
      zoom: 4,
      maxBounds: [[122, 20], [154, 50]],
    });
    mapRef.current = map;
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    map.touchZoomRotate.disableRotation();

    const styleLoaded = new Promise<void>((resolve) => {
      map.once("style.load", () => resolve());
    });
    void Promise.all([
      styleLoaded,
      fetch(`${import.meta.env.BASE_URL}data/municipalities.geojson`).then((response) => {
        if (!response.ok) throw new Error("市区町村の境界データを取得できませんでした。");
        return response.json();
      }),
      fetch(`${import.meta.env.BASE_URL}data/unmarried-rates-2025.json`).then((response) => {
        if (!response.ok) throw new Error("未婚率データを取得できませんでした。");
        return response.json();
      }),
      fetch(`${import.meta.env.BASE_URL}data/prefectures.geojson`).then((response) => {
        if (!response.ok) throw new Error("都道府県境界を取得できませんでした。");
        return response.json();
      }),
    ])
      .then(([, rawCollection, rawRates, prefectures]) => {
        if (cancelled) return;
        const nextCollection = asMunicipalityCollection(rawCollection);
        const nextRates = asRateData(rawRates);
        const initialRates = nextRates.rates.total[INITIAL_AGE] ?? {};
        map.addSource("municipalities", {
          type: "geojson",
          data: withRates(nextCollection, initialRates),
        });
        map.addLayer({
          id: "municipalities-fill",
          type: "fill",
          source: "municipalities",
          paint: { "fill-color": municipalityFillColor("total"), "fill-opacity": 0.92 },
        });
        map.addLayer({
          id: "municipalities-border",
          type: "line",
          source: "municipalities",
          paint: { "line-color": "#ffffff", "line-width": 0.45, "line-opacity": 0.58 },
        });
        map.addSource("prefectures", { type: "geojson", data: prefectures });
        map.addLayer({
          id: "prefectures-border",
          type: "line",
          source: "prefectures",
          paint: { "line-color": "#4b5563", "line-width": 1.15, "line-opacity": 0.78 },
        });
        map.on("mouseenter", "municipalities-fill", () => {
          map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", "municipalities-fill", () => {
          map.getCanvas().style.cursor = "";
        });
        map.on("click", "municipalities-fill", (event) => {
          const properties = event.features?.[0]?.properties;
          const code = properties?.N03_007;
          if (code !== undefined && code !== null) setSelectedCode(String(code).padStart(5, "0"));
        });
        setCollection(nextCollection);
        setRateData(nextRates);
        setLoading(false);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setError(reason instanceof Error ? reason.message : "データの読み込みに失敗しました。");
        setLoading(false);
      });

    return () => {
      cancelled = true;
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !collection || !rateData) return;
    const source = map.getSource("municipalities") as GeoJSONSource | undefined;
    source?.setData(withRates(collection, currentRates));
    if (map.getLayer("municipalities-fill")) {
      map.setPaintProperty("municipalities-fill", "fill-color", municipalityFillColor(displayMode));
    }
  }, [collection, currentRates, displayMode, rateData]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !collection || !map.getSource("municipalities")) return;

    if (!map.getLayer("municipalities-highlight")) {
      map.addLayer({
        id: "municipalities-highlight",
        type: "line",
        source: "municipalities",
        paint: {
          "line-color": "#ffffff",
          "line-width": 5,
        },
        filter: ["==", ["get", "municipalityCode"], ""],
      });
    }

    map.setFilter("municipalities-highlight", [
      "==",
      ["get", "municipalityCode"],
      selectedCode ?? "",
    ]);
  }, [collection, selectedCode]);

  function focusFeature(feature: MunicipalityFeature) {
    const code = String(feature.properties?.N03_007 ?? "").padStart(5, "0");
    if (!code) return;
    setSelectedCode(code);
    setSearch(`${String(feature.properties?.N03_001 ?? "")} ${displayName(feature.properties ?? {})}`.trim());
    setSearchOpen(false);
    const bounds = featureBounds(feature);
    if (bounds) mapRef.current?.fitBounds(bounds, { padding: 70, maxZoom: 8, duration: 850 });
  }

  const delta = selectedSummary && selectedSummary.rate !== null && selectedSummary.nationalRate !== null
    ? selectedSummary.rate - selectedSummary.nationalRate
    : null;
  const selectedColorValue = selectedSummary?.rate ?? null;

  return (
    <div className="app-container">
      <aside className="sidebar">
        <header className="brand">
          <div className="brand__logo">全国未婚率マップ</div>
        </header>

        <div className="search-container">
          <input
            className="search-input"
            aria-label="市区町村を検索"
            placeholder="市区町村を検索..."
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setSearchOpen(true);
            }}
            onFocus={() => setSearchOpen(true)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setSearchOpen(false);
              if (event.key === "Enter" && searchResults[0]) focusFeature(searchResults[0]);
            }}
          />
          {searchOpen && searchResults.length > 0 && (
            <div className="search-dropdown">
              {searchResults.map((feature) => {
                const properties = feature.properties ?? {};
                const code = String(properties.N03_007 ?? "");
                return (
                  <button className="search-dropdown__item" key={code} onClick={() => focusFeature(feature)}>
                    <span className="search-dropdown__name">{displayName(properties)}</span>
                    <span className="search-dropdown__prefecture">{properties.N03_001}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <section className="selector-card" aria-label="表示条件">
          <div className="mode-switcher sex-switcher">
            {rateData?.metadata.sexes.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`mode-switcher__btn${displayMode === item.id ? " mode-switcher__btn--active" : ""}`}
                aria-pressed={displayMode === item.id}
                onClick={() => setDisplayMode(item.id)}
              >
                {item.label}
              </button>
            )) ?? null}
            <button
              type="button"
              className={`mode-switcher__btn${displayMode === "difference" ? " mode-switcher__btn--active" : ""}`}
              aria-pressed={displayMode === "difference"}
              onClick={() => setDisplayMode("difference")}
            >
              男女差
            </button>
          </div>
          <select id="age-group" className="age-select" aria-label="年齢階級" value={age} onChange={(event) => setAge(event.target.value)}>
            {rateData?.metadata.ageGroups.map((group) => (
              <option key={group.id} value={group.id}>{group.label}</option>
            )) ?? <option value={INITIAL_AGE}>30～34歳</option>}
          </select>
        </section>

        <section className="info-panel">
          {selectedSummary ? (
            <article className="region-card">
              <div className="region-card__header">
                <div className="region-card__info">
                  <h2 className="region-card__name">{selectedSummary.name}</h2>
                  <p className="region-card__prefecture">{selectedSummary.prefecture}</p>
                </div>
                <div className="score-display">
                  <span className="score-display__value" style={{ color: valueColor(selectedColorValue, displayMode) }}>
                    {selectedSummary.rate === null
                      ? "—"
                      : displayMode === "difference"
                        ? `${selectedSummary.rate >= 0 ? "+" : "−"}${Math.abs(selectedSummary.rate).toFixed(1)} pt`
                        : `${selectedSummary.rate.toFixed(1)}%`}
                  </span>
                </div>
              </div>
              {selectedSummary.rate !== null ? (
                <div className="comparison-card">
                  <span className="comparison-card__label">全国平均</span>
                  <strong>
                    {selectedSummary.nationalRate === null
                      ? "—"
                      : displayMode === "difference"
                        ? `${selectedSummary.nationalRate >= 0 ? "+" : "−"}${Math.abs(selectedSummary.nationalRate).toFixed(1)} pt`
                        : `${selectedSummary.nationalRate.toFixed(1)}%`}
                  </strong>
                  {delta !== null && (
                    <span className={`comparison-card__delta${delta >= 0 ? " is-positive" : " is-negative"}`}>
                      {delta >= 0 ? "+" : "−"}{Math.abs(delta).toFixed(1)} pt
                    </span>
                  )}
                </div>
              ) : (
                <p className="no-data-note">この地域・条件の値は公表されていません。</p>
              )}
              <div className="region-card__population">
                <span className="region-card__population-label">対象人口</span>
                <strong>
                  {displayMode === "difference"
                    ? `男性 ${formatPopulation(selectedSummary.malePopulation)} ・ 女性 ${formatPopulation(selectedSummary.femalePopulation)}`
                    : formatPopulation(selectedSummary.population)}
                </strong>
              </div>
              <p className="region-card__source">2025年国勢調査 ・ 配偶関係の不詳補完値</p>
            </article>
          ) : (
            <div className="info-panel__empty">
              <div className="info-panel__empty-icon">⌖</div>
              <p>地図上の地域を選ぶと、<br />{displayMode === "difference" ? "未婚率の男女差" : "未婚率"}を表示します。</p>
            </div>
          )}
        </section>

        <section className="legend">
          {displayMode === "difference" && (
            <p className="legend__caption">色は男性−女性の未婚率（ポイント）</p>
          )}
          <div className="legend__gradient-container">
            <div className="legend__gradient unmarried-gradient" />
          </div>
          <div className="legend__labels">
            {displayMode === "difference"
              ? <><span>−25 pt</span><span>−12.5 pt</span><span>0 pt</span><span>+12.5 pt</span><span>+25 pt</span></>
              : <><span>0%</span><span>25%</span><span>50%</span><span>75%</span><span>100%</span></>}
          </div>
          <p className="no-data-legend"><span /> データなし</p>
        </section>
        <footer className="source-footer">
          <p>出典: 総務省統計局「令和7年国勢調査」（不詳補完値）</p>
          <p>国籍総数（日本人・外国人を含む）</p>
        </footer>
      </aside>

      <main className="map-container" aria-label={displayMode === "difference" ? "市区町村別未婚率男女差地図" : "市区町村別未婚率地図"}>
        <div className="map-canvas" ref={mapContainer} />
        {loading && (
          <div className="loading-overlay"><div className="loading-spinner" /><span>地図データを読み込み中</span></div>
        )}
        {error && <div className="map-error" role="alert">{error}</div>}
      </main>
    </div>
  );
}

export default App;
