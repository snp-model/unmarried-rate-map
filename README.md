# 全国未婚率マップ

令和7年（2025年）国勢調査の市区町村別未婚率を、男女別・男女差・5歳階級別に地図で見るアプリです。初期表示は**男女計・30～34歳**です。

## 開発

```bash
npm install
npm run dev
```

## 未婚率データの再生成

Python 3.10以降で実行できます。値の計算は境界データに依存せず、標準ライブラリのみで処理します。80歳以上は第4-3表の人口を合算し、配偶関係が判明している人口に占める未婚者の割合を再計算します。選択カードに表示する対象人口も第4-3表から取得します。

```bash
python3 scripts/download_census_data.py
python3 scripts/process_census_data.py
```

出力は `public/data/unmarried-rates-2025.json` です。生のExcelファイルは `data/source/` に置き、Gitには含めません。

## 市区町村境界の再生成

国土数値情報 N03-2025 の未簡略化GeoJSONを `data/source/N03-20250101.geojson` に置きます。GeoPandasとShapely 2.1以降を使って市区町村形状を作ります。

```bash
python3 -m pip install -r scripts/requirements-boundaries.txt
python3 scripts/simplify_municipality_boundaries.py --source data/source/N03-20250101.geojson
```

出力は `public/data/municipalities.geojson` と `public/data/prefectures.geojson` です。値JSONと境界GeoJSONは市区町村コードで画面上で結合するため、どちらも独立して再生成できます。境界元データも `data/source/` に置き、Gitには含めません。

## データと指標

- 未婚率: e-Stat「令和7年国勢調査 人口等基本集計（不詳補完値）第4-4表」の人口構成比を使用。80歳以上は第4-3表の補完後人口を合算して算出
- 分母: 配偶関係の不詳を補完した人口構成比（80歳以上は補完後の配偶関係が判明している人口を分母に算出）
- 対象: 国籍総数（日本人・外国人を含む。日本人・外国人の別不詳を含む）
- 地域境界: 国土交通省「国土数値情報 行政区域データ N03-2025」を加工
- 表示できない地域はグレーで表示

統計表: <https://www.e-stat.go.jp/dbview?sid=0004066272>
統計表ファイルID: 第4-4表 `000040506667`、第4-3表 `000040506666`。ダウンロードスクリプトでSHA-256を照合します。
境界データ: <https://nlftp.mlit.go.jp/ksj/>

## 表示上の注意

「未婚」はこれまで結婚したことがない人の区分で、離別・死別は別集計です。男女別表示の地図色は全国平均との差、男女差表示の値と地図色は男性の未婚率から女性の未婚率を引いたポイント差です。男女差は±25ポイントを超えると色の端の値にまとめて表示します。町丁・字単位ではなく市区町村単位の表示です。

## 出典表記

統計データ: 総務省統計局「令和7年国勢調査」
境界データ: 国土交通省「国土数値情報 行政区域データ N03-2025」
背景地図: 国土地理院「地理院タイル（淡色地図）」
