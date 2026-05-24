/**
 * バックテスト用ユニバース（候補銘柄プール）
 *
 * 選定基準:
 * - TSE プライム or スタンダード市場の主要銘柄
 * - 概ね 300〜5000円帯（フィルター後に十分な候補数が残るように）
 * - セクター分散（特定業種に偏らない）
 * - 流動性が高い（出来高が安定）
 *
 * 約80銘柄。バックテスト中はこのリスト全部のOHLCVを取得してメモリに展開し、
 * 各日付でフィルター→Claude判定する流れ。
 *
 * 銘柄価格は変動するため、フィルター(300-5000円)から外れる銘柄が出てもOK。
 * その日候補にならないだけで、リスト自体に害はない。
 */
export const BACKTEST_UNIVERSE: { ticker: string; name: string }[] = [
  // 食品・小売
  { ticker: '2269', name: '明治HD' },
  { ticker: '2502', name: 'アサヒGHD' },
  { ticker: '2503', name: 'キリンHD' },
  { ticker: '2802', name: '味の素' },
  { ticker: '2914', name: 'JT' },
  { ticker: '3086', name: 'J.フロント' },
  { ticker: '3099', name: '三越伊勢丹' },
  { ticker: '3382', name: 'セブン&アイ' },
  { ticker: '8267', name: 'イオン' },
  { ticker: '7532', name: 'パンパシHD' },

  // 化学・素材
  { ticker: '3402', name: '東レ' },
  { ticker: '3407', name: '旭化成' },
  { ticker: '4005', name: '住友化学' },
  { ticker: '4063', name: '信越化学' },
  { ticker: '4188', name: '三菱ケミG' },
  { ticker: '5108', name: 'ブリヂストン' },
  { ticker: '5201', name: 'AGC' },
  { ticker: '5301', name: '東海カーボン' },
  { ticker: '5333', name: '日本ガイシ' },
  { ticker: '5401', name: '日本製鉄' },

  // 機械・電機
  { ticker: '6301', name: 'コマツ' },
  { ticker: '6326', name: 'クボタ' },
  { ticker: '6367', name: 'ダイキン' },
  { ticker: '6471', name: '日本精工' },
  { ticker: '6501', name: '日立' },
  { ticker: '6502', name: '東芝' },
  { ticker: '6503', name: '三菱電機' },
  { ticker: '6701', name: 'NEC' },
  { ticker: '6702', name: '富士通' },
  { ticker: '6723', name: 'ルネサス' },
  { ticker: '6752', name: 'パナソニックHD' },
  { ticker: '6753', name: 'シャープ' },
  { ticker: '6841', name: '横河電機' },
  { ticker: '6857', name: 'アドバンテスト' },
  { ticker: '6920', name: 'レーザーテック' },

  // 自動車・輸送機
  { ticker: '7012', name: '川崎重工業' },
  { ticker: '7013', name: 'IHI' },
  { ticker: '7203', name: 'トヨタ自動車' },
  { ticker: '7211', name: '三菱自動車' },
  { ticker: '7261', name: 'マツダ' },
  { ticker: '7267', name: 'ホンダ' },
  { ticker: '7270', name: 'SUBARU' },
  { ticker: '7269', name: 'スズキ' },

  // 精密・医療
  { ticker: '4502', name: '武田薬品' },
  { ticker: '4503', name: 'アステラス' },
  { ticker: '4519', name: '中外製薬' },
  { ticker: '4523', name: 'エーザイ' },
  { ticker: '4543', name: 'テルモ' },
  { ticker: '4901', name: '富士フイルム' },
  { ticker: '4911', name: '資生堂' },
  { ticker: '7741', name: 'HOYA' },
  { ticker: '7733', name: 'オリンパス' },
  { ticker: '7751', name: 'キヤノン' },

  // 金融・不動産
  { ticker: '8001', name: '伊藤忠商事' },
  { ticker: '8002', name: '丸紅' },
  { ticker: '8031', name: '三井物産' },
  { ticker: '8053', name: '住友商事' },
  { ticker: '8058', name: '三菱商事' },
  { ticker: '8306', name: '三菱UFJ' },
  { ticker: '8411', name: 'みずほFG' },
  { ticker: '8591', name: 'オリックス' },
  { ticker: '8604', name: '野村HD' },
  { ticker: '8766', name: '東京海上HD' },
  { ticker: '8801', name: '三井不動産' },
  { ticker: '8802', name: '三菱地所' },

  // 運輸・サービス
  { ticker: '9001', name: '東武鉄道' },
  { ticker: '9005', name: '東急' },
  { ticker: '9020', name: 'JR東日本' },
  { ticker: '9022', name: 'JR東海' },
  { ticker: '9101', name: '日本郵船' },
  { ticker: '9104', name: '商船三井' },
  { ticker: '9107', name: '川崎汽船' },
  { ticker: '9201', name: 'JAL' },
  { ticker: '9202', name: 'ANA' },
  { ticker: '9301', name: '三菱倉庫' },

  // 情報・通信・電力
  { ticker: '4324', name: '電通G' },
  { ticker: '4751', name: 'サイバーエージェント' },
  { ticker: '6098', name: 'リクルートHD' },
  { ticker: '6178', name: '日本郵政' },
  { ticker: '9432', name: 'NTT' },
  { ticker: '9433', name: 'KDDI' },
  { ticker: '9434', name: 'ソフトバンク' },
  { ticker: '9501', name: '東京電力' },
  { ticker: '9502', name: '中部電力' },
  { ticker: '9503', name: '関西電力' },
]
