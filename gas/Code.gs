/**
 * ============================================================================
 * 新竹縣政府消防局 管制藥品損壞/遺失事故報告單 — Google Apps Script 雲端傳簽後端 (Code.gs)
 * ============================================================================
 * 支援流程：
 * 1. 事故人員填寫表單與上傳照片 -> 儲存至雲端並產生專屬傳簽連結 (?id=單號)
 * 2. 四級主管（分隊長、醫療指導醫師、緊急救護科、藥劑科主任）開啟同一連結 ->
 *    自動載入單據與照片 -> 填寫主管意見與日期 -> 更新雲端同一筆單據
 * 3. 全部主管填寫完畢後 -> 事故人員開啟同一連結檢視完整內容 -> 列印 A4 紙本由各級主管蓋章
 */

const SHEET_NAME = '管制藥品事故報告單紀錄';
const DRUG_SHEET_NAME = '藥品品項清單';
const DRIVE_ROOT_FOLDER_NAME = '新竹縣消防局_管制藥品事故照片';

/**
 * 處理 GET 請求：
 * - ?action=ping            : 測試雲端連線，並自動初始化試算表與回傳最新藥品品項 (方案 C)
 * - ?action=getReport&id=   : 依流水編號讀取單筆完整報告單（含還原照片與藥品清單）
 * - ?action=listReports     : 讀取最近 50 筆報告單清單
 * - ?action=getDrugCatalog  : 讀取「藥品品項清單」工作表最新藥品標準目錄 (方案 C)
 */
function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'ping';

  try {
    if (action === 'ping') {
      ensureSheetInitialized_();
      const drugs = getDrugCatalog_();
      return jsonResponse_({
        status: 'success',
        message: '新竹縣政府消防局管制藥品事故報告單 雲端傳簽後端連線正常！',
        drugs: drugs
      });
    }

    if (action === 'getDrugCatalog') {
      const drugs = getDrugCatalog_();
      return jsonResponse_({
        status: 'success',
        drugs: drugs
      });
    }

    if (action === 'getReport') {
      const id = (e && e.parameter && e.parameter.id) || '';
      if (!id) {
        return jsonResponse_({ status: 'error', message: '缺少單號參數 (id)' });
      }
      const record = getReportById_(id);
      if (!record) {
        return jsonResponse_({ status: 'error', message: '找不到單號：' + id });
      }
      return jsonResponse_({
        status: 'success',
        record: record,
        drugs: getDrugCatalog_()
      });
    }

    if (action === 'listReports') {
      const records = getRecentRecords_(50);
      return jsonResponse_({
        status: 'success',
        records: records
      });
    }

    return jsonResponse_({ status: 'success', message: 'GAS Web App Active' });
  } catch (err) {
    return jsonResponse_({ status: 'error', message: err.toString() });
  }
}

/**
 * 處理 POST 請求：
 * - 新增或更新（Upsert）同一單號之事故報告單與四級主管簽核意見
 */
function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);

  try {
    const rawBody = e.postData && e.postData.contents ? e.postData.contents : '{}';
    const requestObj = JSON.parse(rawBody);
    const incoming = requestObj.payload || requestObj;
    const incomingDirtyFields = Array.isArray(requestObj.dirtyFields) ? requestObj.dirtyFields : null;

    const sheet = ensureSheetInitialized_();
    const serialNumber = incoming.serialNumber || generateServerSerial_(sheet);
    incoming.serialNumber = serialNumber;

    // 檢查試算表中是否已存在相同單號（若存在則為「主管簽核更新」或「修改重送」）
    const existingRowInfo = findRowBySerial_(sheet, serialNumber);
    const existingData = existingRowInfo ? existingRowInfo.data : {};

    // 合併既有資料與新送出資料（智慧三方合併：避免多人同時填寫不同主管意見時相互覆蓋）
    const merged = smartMergeReportData_(existingData, incoming, incomingDirtyFields);

    // 處理照片上傳至 Google Drive
    let photo1Url = merged.photo1DriveUrl || existingData.photo1DriveUrl || '';
    let photo2Url = merged.photo2DriveUrl || existingData.photo2DriveUrl || '';
    let photo1FileId = merged.photo1FileId || existingData.photo1FileId || '';
    let photo2FileId = merged.photo2FileId || existingData.photo2FileId || '';
    let folderUrl = merged.driveFolderUrl || existingData.driveFolderUrl || '';

    const hasNewPhoto1 = incoming.photo1 && incoming.photo1.indexOf('data:image') === 0;
    const hasNewPhoto2 = incoming.photo2 && incoming.photo2.indexOf('data:image') === 0;

    if (hasNewPhoto1 || hasNewPhoto2) {
      const folder = getOrCreateCaseFolder_(serialNumber, merged.unit || '未填分隊');
      folderUrl = folder.getUrl();

      if (hasNewPhoto1) {
        const saved1 = saveBase64ImageToFolder_(folder, incoming.photo1, `${serialNumber}_照片一.jpg`);
        photo1Url = saved1.url;
        photo1FileId = saved1.id;
      }
      if (hasNewPhoto2) {
        const saved2 = saveBase64ImageToFolder_(folder, incoming.photo2, `${serialNumber}_照片二.jpg`);
        photo2Url = saved2.url;
        photo2FileId = saved2.id;
      }
    }

    // 若前端明確指示清除照片（僅當 dirtyFields 指名 photo1 且傳入空字串）
    const isPhoto1Dirty = incomingDirtyFields && incomingDirtyFields.indexOf('photo1') !== -1;
    const isPhoto2Dirty = incomingDirtyFields && incomingDirtyFields.indexOf('photo2') !== -1;
    if (isPhoto1Dirty && incoming.photo1 === '') {
      photo1Url = '';
      photo1FileId = '';
    }
    if (isPhoto2Dirty && incoming.photo2 === '') {
      photo2Url = '';
      photo2FileId = '';
    }

    merged.photo1DriveUrl = photo1Url;
    merged.photo2DriveUrl = photo2Url;
    merged.photo1FileId = photo1FileId;
    merged.photo2FileId = photo2FileId;
    merged.driveFolderUrl = folderUrl;
    merged.updatedAt = new Date().toISOString();

    // 存入結構欄位的 JSON 不塞入龐大 Base64，改以 Drive File ID 供讀取時動態還原
    const jsonToStore = Object.assign({}, merged, {
      photo1: '',
      photo2: ''
    });

    // 計算目前簽核進度摘要
    const signProgress = computeApprovalStatusText_(merged);

    const rowValues = [
      serialNumber,
      new Date(),
      signProgress,
      (merged.incidentTypes || []).join('、'),
      merged.unit || '',
      merged.reportDate || '',
      merged.noCaseNumber ? '無案件編號' : (merged.caseNumber || ''),
      merged.emsRecordNumber || '',
      `${merged.occurDate || ''} ${merged.occurTime || ''}`.trim(),
      (merged.occurPlaces || []).join('、') + (merged.occurPlaceOtherText ? ` (${merged.occurPlaceOtherText})` : ''),
      merged.drugNameZh || '',
      merged.drugNameEn || '',
      (merged.controlLevels || []).join('、'),
      merged.drugQty || '',
      merged.drugUnit || '',
      merged.drugSpec || '',
      merged.batchNumber || '',
      merged.expiryDate || '',
      merged.custodian || '',
      merged.reporter || '',
      merged.contactPhone || '',
      merged.reportContent || '',
      photo1Url,
      photo2Url,
      folderUrl,
      (merged.policeStatuses || []).join('、'),
      merged.policeUnit || '',
      merged.policeDate || '',
      merged.policeDocNo || '',
      [merged.improve1, merged.improve2, merged.improve3].filter(Boolean).join('\n'),
      formatChiefSummary_(merged),
      formatSingleOpinion_(merged.doctorOpinion, merged.doctorDate),
      formatSingleOpinion_(merged.emsOpinion, merged.emsDate),
      formatPharmacySummary_(merged),
      JSON.stringify(jsonToStore)
    ];

    if (existingRowInfo) {
      sheet.getRange(existingRowInfo.rowNumber, 1, 1, rowValues.length).setValues([rowValues]);
    } else {
      sheet.appendRow(rowValues);
    }

    return jsonResponse_({
      status: 'success',
      serialNumber: serialNumber,
      signProgress: signProgress,
      folderUrl: folderUrl,
      record: jsonToStore,
      isUpdate: Boolean(existingRowInfo),
      message: existingRowInfo
        ? '已成功儲存！已自動同步合併所有主管最新傳簽意見。'
        : '已成功建立雲端傳簽單據！'
    });
  } catch (err) {
    return jsonResponse_({
      status: 'error',
      message: err.toString()
    });
  } finally {
    lock.releaseLock();
  }
}

/**
 * 智慧三方差分合併演算法：支援多人同時開啟傳簽連結填報，保護各主管意見不被空白欄位相互覆蓋
 * @param {Object} existing 雲端試算表中目前既有的報告資料
 * @param {Object} incoming 前端本次送出的表單資料
 * @param {Array<string>|null} dirtyFields 前端標記本次實際修改的欄位清單
 * @return {Object} 合併後的完整資料物件
 */
function smartMergeReportData_(existing, incoming, dirtyFields) {
  if (!existing || Object.keys(existing).length === 0) {
    return Object.assign({}, incoming);
  }

  const merged = Object.assign({}, existing);

  function isEmptyVal_(v) {
    if (v === undefined || v === null) return true;
    if (typeof v === 'string' && v.trim() === '') return true;
    if (Array.isArray(v) && v.length === 0) return true;
    return false;
  }

  // 四級主管專屬欄位清單
  const SUPERVISOR_FIELDS = [
    'chiefDutyTypes', 'chiefDutyOther', 'chiefDutyCerts', 'chiefOpinion', 'chiefDate',
    'doctorOpinion', 'doctorDate',
    'emsOpinion', 'emsDate',
    'pharmacyAction', 'pharmacyAdvice', 'pharmacyDate'
  ];

  if (Array.isArray(dirtyFields) && dirtyFields.length > 0) {
    // 方案 A：精確差分合併（依前端實際修改之欄位更新，未修改者保留既有值）
    for (var i = 0; i < dirtyFields.length; i++) {
      var key = dirtyFields[i];
      if (key in incoming) {
        merged[key] = incoming[key];
      }
    }
  } else {
    // 方案 B：安全向後相容合併（若未傳入 dirtyFields，嚴禁以空白欄位覆寫既有內容）
    for (var k in incoming) {
      if (!incoming.hasOwnProperty(k)) continue;
      var inVal = incoming[k];
      var exVal = existing[k];

      if (SUPERVISOR_FIELDS.indexOf(k) !== -1) {
        // 主管欄位：若新值為空但既有已有內容，一律保留既有內容
        if (!isEmptyVal_(inVal)) {
          merged[k] = inVal;
        } else if (isEmptyVal_(exVal)) {
          merged[k] = inVal;
        } else {
          merged[k] = exVal;
        }
      } else {
        // 基本資料欄位
        if (!isEmptyVal_(inVal)) {
          merged[k] = inVal;
        } else if (isEmptyVal_(exVal)) {
          merged[k] = inVal;
        } else {
          merged[k] = exVal;
        }
      }
    }
  }

  // 確保單號與相片連結不丟失
  merged.serialNumber = existing.serialNumber || incoming.serialNumber;
  if (!incoming.photo1 && existing.photo1DriveUrl) {
    merged.photo1DriveUrl = existing.photo1DriveUrl;
    merged.photo1FileId = existing.photo1FileId;
  }
  if (!incoming.photo2 && existing.photo2DriveUrl) {
    merged.photo2DriveUrl = existing.photo2DriveUrl;
    merged.photo2FileId = existing.photo2FileId;
  }
  if (existing.driveFolderUrl) {
    merged.driveFolderUrl = existing.driveFolderUrl;
  }

  return merged;
}

function computeApprovalStatusText_(d) {
  const done = [];
  if (d.chiefOpinion || d.chiefDate || (d.chiefDutyTypes && d.chiefDutyTypes.length) || (d.chiefDutyCerts && d.chiefDutyCerts.length)) {
    done.push('分隊長');
  }
  if (d.doctorOpinion || d.doctorDate) {
    done.push('指導醫師');
  }
  if (d.emsOpinion || d.emsDate) {
    done.push('救護科');
  }
  if (d.pharmacyAction || d.pharmacyAdvice || d.pharmacyDate) {
    done.push('藥劑科');
  }
  if (done.length === 0) return '待各級主管填寫意見 (0/4)';
  if (done.length === 4) return '✅ 四級主管均已填寫完畢 (4/4 可列印蓋章)';
  return `傳簽中 (${done.length}/4 已填：${done.join('、')})`;
}

function formatChiefSummary_(d) {
  const parts = [];
  const duty = (d.chiefDutyTypes || []).join('、') + (d.chiefDutyOther ? `(${d.chiefDutyOther})` : '');
  const cert = (d.chiefDutyCerts || []).join('、');
  if (duty || cert) parts.push(`判定：${[duty, cert].filter(Boolean).join(' / ')}`);
  if (d.chiefOpinion) parts.push(`意見：${d.chiefOpinion}`);
  if (d.chiefDate) parts.push(`日期：${d.chiefDate}`);
  return parts.join('\n');
}

function formatSingleOpinion_(opinion, dateStr) {
  const parts = [];
  if (opinion) parts.push(`意見：${opinion}`);
  if (dateStr) parts.push(`日期：${dateStr}`);
  return parts.join('\n');
}

function formatPharmacySummary_(d) {
  const parts = [];
  if (d.pharmacyAction) parts.push(`處理方式：${d.pharmacyAction}`);
  if (d.pharmacyAdvice) parts.push(`其他建議：${d.pharmacyAdvice}`);
  if (d.pharmacyDate) parts.push(`日期：${d.pharmacyDate}`);
  return parts.join('\n');
}

/**
 * 確保工作表存在且包含標題列
 */
function ensureSheetInitialized_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    const headers = [
      '流水編號',
      '最後更新時間',
      '傳簽進度狀態',
      '事故類別',
      '單位',
      '填表日期',
      '案件編號',
      '救護紀錄表號',
      '發生時間',
      '發生地點',
      '藥品中文名稱',
      '藥品英文名稱',
      '管制級別',
      '數量',
      '單位',
      '規格',
      '批號',
      '效期',
      '保管人',
      '報告者',
      '聯絡電話',
      '報告內容',
      '照片一連結 (Drive)',
      '照片二連結 (Drive)',
      '案件照片資料夾連結',
      '報案證明狀態',
      '報案受理單位',
      '報案日期',
      '報案文號',
      '改善方案 (1~3)',
      '分隊長主管意見',
      '醫療指導醫師意見',
      '緊急救護科主管意見',
      '仁慈醫院藥劑科主任意見',
      '完整結構資料(JSON)'
    ];
    sheet.appendRow(headers);

    const headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setBackground('#FF5809');
    headerRange.setFontColor('#FFFFFF');
    headerRange.setFontWeight('bold');
    sheet.setFrozenRows(1);
  }

  // 同步確保藥品品項清單工作表已就緒
  ensureDrugSheetInitialized_();

  return sheet;
}

/**
 * 預設管制藥品標準品項清單（初次建立工作表時自動填入）
 */
const DEFAULT_DRUG_CATALOG = [
  {
    zh: '納布芬注射液 (芯奔)',
    en: 'Nalbuphine (Bain Injection)',
    spec: '10mg/1mL/Amp',
    level: '非管制藥',
    unit: '支(Amp)',
    status: '啟用'
  },
  {
    zh: '咪達唑侖注射液 (導眠靜)',
    en: 'Midazolam Injection (Dormicum)',
    spec: '5mg/1mL/Amp',
    level: '四級',
    unit: '支(Amp)',
    status: '啟用'
  },
  {
    zh: '嗎啡注射液',
    en: 'Morphine HCl Injection',
    spec: '20mg/1mL/Amp',
    level: '一級',
    unit: '支(Amp)',
    status: '啟用'
  },
  {
    zh: '愷他命注射液 (克太拉)',
    en: 'Ketamine Injection',
    spec: '500mg/10mL/Vial',
    level: '三級',
    unit: '瓶(Vial)',
    status: '啟用'
  }
];

/**
 * 確保「藥品品項清單」工作表存在且初始化預設資料 (方案 C)
 */
function ensureDrugSheetInitialized_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(DRUG_SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(DRUG_SHEET_NAME);
    const headers = [
      '藥品中文名稱',
      '藥品英文名稱',
      '規格',
      '管制級別',
      '計量單位',
      '狀態 (啟用/停用)'
    ];
    sheet.appendRow(headers);

    const headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setBackground('#005BBB');
    headerRange.setFontColor('#FFFFFF');
    headerRange.setFontWeight('bold');

    DEFAULT_DRUG_CATALOG.forEach(function(item) {
      sheet.appendRow([item.zh, item.en, item.spec, item.level, item.unit, item.status]);
    });

    sheet.setFrozenRows(1);
    sheet.autoResizeColumns(1, headers.length);
  }

  return sheet;
}

/**
 * 讀取「藥品品項清單」工作表之所有有效藥品 (方案 C)
 * 支援管理人員隨時於試算表直接新增、修改或將狀態改為「停用」
 */
function getDrugCatalog_() {
  try {
    const sheet = ensureDrugSheetInitialized_();
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) {
      return DEFAULT_DRUG_CATALOG.map(function(d) {
        return { zh: d.zh, en: d.en, spec: d.spec, level: d.level, unit: d.unit };
      });
    }

    const data = sheet.getRange(2, 1, lastRow - 1, 6).getValues();
    const catalog = [];
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const zh = String(row[0] || '').trim();
      const en = String(row[1] || '').trim();
      const spec = String(row[2] || '').trim();
      const level = String(row[3] || '').trim();
      const unit = String(row[4] || '').trim();
      const status = String(row[5] || '').trim();

      // 若未填寫中文名稱或狀態設定為「停用」，則略過
      if (!zh) continue;
      if (status === '停用') continue;

      catalog.push({
        zh: zh,
        en: en,
        spec: spec,
        level: level,
        unit: unit
      });
    }

    return catalog.length > 0 ? catalog : DEFAULT_DRUG_CATALOG.map(function(d) {
      return { zh: d.zh, en: d.en, spec: d.spec, level: d.level, unit: d.unit };
    });
  } catch (e) {
    return DEFAULT_DRUG_CATALOG.map(function(d) {
      return { zh: d.zh, en: d.en, spec: d.spec, level: d.level, unit: d.unit };
    });
  }
}

/**
 * 依流水編號尋找既有列
 */
function findRowBySerial_(sheet, serialNumber) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return null;

  const numRows = lastRow - 1;
  const colCount = sheet.getLastColumn();
  const values = sheet.getRange(2, 1, numRows, colCount).getValues();

  for (let i = values.length - 1; i >= 0; i--) {
    if (String(values[i][0]).trim() === String(serialNumber).trim()) {
      const jsonCol = values[i][colCount - 1];
      let parsed = {};
      if (jsonCol) {
        try {
          parsed = JSON.parse(jsonCol);
        } catch (e) {
          parsed = {};
        }
      }
      return {
        rowNumber: i + 2,
        data: parsed
      };
    }
  }
  return null;
}

/**
 * 依單號讀取單筆報告單，並將 Drive 中的照片轉回 Base64 DataURL 供前端跨裝置顯示與列印
 */
function getReportById_(serialNumber) {
  const sheet = ensureSheetInitialized_();
  const found = findRowBySerial_(sheet, serialNumber);
  if (!found) return null;

  const record = found.data;
  if (record.photo1FileId) {
    record.photo1 = loadDriveFileAsDataUrl_(record.photo1FileId);
  }
  if (record.photo2FileId) {
    record.photo2 = loadDriveFileAsDataUrl_(record.photo2FileId);
  }
  return record;
}

function loadDriveFileAsDataUrl_(fileId) {
  try {
    const file = DriveApp.getFileById(fileId);
    const blob = file.getBlob();
    const contentType = blob.getContentType() || 'image/jpeg';
    const base64 = Utilities.base64Encode(blob.getBytes());
    return `data:${contentType};base64,${base64}`;
  } catch (e) {
    return '';
  }
}

/**
 * 讀取最近 N 筆紀錄供前端歷史列表顯示
 */
function getRecentRecords_(limit) {
  const sheet = ensureSheetInitialized_();
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];

  const colCount = sheet.getLastColumn();
  const startRow = Math.max(2, lastRow - limit + 1);
  const numRows = lastRow - startRow + 1;
  const dataRange = sheet.getRange(startRow, 1, numRows, colCount).getValues();

  const records = [];
  for (let i = dataRange.length - 1; i >= 0; i--) {
    const row = dataRange[i];
    const jsonCol = row[colCount - 1];
    if (jsonCol) {
      try {
        const parsed = JSON.parse(jsonCol);
        parsed.signProgress = row[2] || computeApprovalStatusText_(parsed);
        records.push(parsed);
        continue;
      } catch (e) {
        // fallback below
      }
    }
    records.push({
      serialNumber: row[0],
      signProgress: row[2] || '',
      incidentTypes: row[3] ? String(row[3]).split('、') : [],
      unit: row[4],
      reportDate: row[5],
      drugNameZh: row[10],
      drugQty: row[13],
      drugUnit: row[14],
      reporter: row[19]
    });
  }
  return records;
}

/**
 * 產生伺服器端民國年流水號
 */
function generateServerSerial_(sheet) {
  const now = new Date();
  const rocYear = now.getFullYear() - 1911;
  const m = ('0' + (now.getMonth() + 1)).slice(-2);
  const d = ('0' + now.getDate()).slice(-2);
  const seq = ('00' + sheet.getLastRow()).slice(-3);
  return `HCFD-${rocYear}${m}${d}-${seq}`;
}

function getOrCreateCaseFolder_(serialNumber, unitName) {
  const rootIter = DriveApp.getFoldersByName(DRIVE_ROOT_FOLDER_NAME);
  const rootFolder = rootIter.hasNext()
    ? rootIter.next()
    : DriveApp.createFolder(DRIVE_ROOT_FOLDER_NAME);

  const subFolderName = `${serialNumber}_${unitName}`;
  const subIter = rootFolder.getFoldersByName(subFolderName);
  return subIter.hasNext()
    ? subIter.next()
    : rootFolder.createFolder(subFolderName);
}

function saveBase64ImageToFolder_(folder, dataUrl, fileName) {
  const parts = dataUrl.split(',');
  const mimeMatch = parts[0].match(/:(.*?);/);
  const contentType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
  const byteCharacters = Utilities.base64Decode(parts[1]);
  const blob = Utilities.newBlob(byteCharacters, contentType, fileName);
  const file = folder.createFile(blob);
  return {
    id: file.getId(),
    url: file.getUrl()
  };
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
