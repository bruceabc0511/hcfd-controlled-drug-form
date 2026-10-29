/**
 * 新竹縣政府消防局 管制藥品損壞/遺失事故報告單 電子表單系統
 * 前端核心邏輯 (app.js) — 支援事故人員填報、四級主管電子傳簽、雲端同步與 A4 紙本列印蓋章
 */

// 預設 Google Apps Script 雲端傳簽後端網址（全體同仁與主管打開網頁即自動連線）
const DEFAULT_GAS_URL = 'https://script.google.com/macros/s/AKfycbzV2Ypsl_iC-zyFd9pkL10jBSyGmL8J5FpAvknEACRWaVA7SKELxFjXtocxj7IRNmMX/exec';

const STORAGE_KEYS = {
  DRAFT: 'hcfd_controlled_drug_draft_v1',
  HISTORY: 'hcfd_controlled_drug_history_v1',
  GAS_URL: 'hcfd_controlled_drug_gas_url_v1',
  SERIAL_COUNTER: 'hcfd_controlled_drug_seq_v1',
  CUSTOM_OPTIONS: 'hcfd_controlled_drug_custom_options_v1'
};

// 常見管制藥品快速帶入字典（含預設項目，並會自動學習使用者手動填入的新藥品與屬性）
const COMMON_DRUGS_DICT = {
  '納布芬注射液(芯奔)': { en: 'Nalbuphine (Bain Injection)', level: '非管制藥', spec: '10mg/ml, 1ml/Amp', unit: '支(Amp)' },
  '咪達唑侖注射液(導美睡)': { en: 'Midazolam Injection (Dormicum)', level: '四級', spec: '5mg/ml, 3ml/Amp', unit: '支(Amp)' },
  '嗎啡注射液': { en: 'Morphine HCl Injection', level: '一級', spec: '10mg/1ml/Amp', unit: '支(Amp)' },
  '愷他命注射液': { en: 'Ketamine Injection', level: '三級', spec: '50mg/ml, 10ml/Vial', unit: '瓶(Vial)' }
};

// 儲存照片 Base64 狀態
const photoState = {
  photo1: '',
  photo2: ''
};

document.addEventListener('DOMContentLoaded', async () => {
  loadCustomOptionsFromStorage();
  initDefaultDatesAndSerial();
  bindFormEvents();
  bindPhotoUploaders();
  bindToolbarAndModals();
  initCloudUrlFromQueryOrDefault();
  updateCloudStatusUI();

  // 檢查網址是否帶有傳簽單號 (?id=HCFD-...)
  const hasSharedId = await checkAndLoadSharedReportFromUrl();
  if (!hasSharedId) {
    loadDraftFromStorage();
    setBaselineSnapshot();
  }
  syncPrintView();
  updateWorkflowProgressUI();
  updateShareLinkDisplay();
});

/* ==========================================================================
   0. 雲端網址解析與傳簽連結 (?id=單號&api=金鑰) 自動載入
   ========================================================================== */
function getActiveGasUrl() {
  return localStorage.getItem(STORAGE_KEYS.GAS_URL) || DEFAULT_GAS_URL || '';
}

function initCloudUrlFromQueryOrDefault() {
  const params = new URLSearchParams(window.location.search);
  const apiParam = params.get('api');
  if (apiParam) {
    const fullUrl = apiParam.startsWith('http')
      ? apiParam
      : `https://script.google.com/macros/s/${apiParam}/exec`;
    localStorage.setItem(STORAGE_KEYS.GAS_URL, fullUrl);
  } else if (DEFAULT_GAS_URL && !localStorage.getItem(STORAGE_KEYS.GAS_URL)) {
    localStorage.setItem(STORAGE_KEYS.GAS_URL, DEFAULT_GAS_URL);
  }
}

function extractGasDeploymentId(url) {
  const match = String(url || '').match(/\/macros\/s\/([^/]+)\/exec/);
  return match ? match[1] : '';
}

function buildShareableUrl(serialNumber) {
  const baseUrl = window.location.origin + window.location.pathname;
  const gasUrl = getActiveGasUrl();
  const depId = extractGasDeploymentId(gasUrl);
  const params = new URLSearchParams();
  params.set('id', serialNumber);
  if (depId && !DEFAULT_GAS_URL) {
    params.set('api', depId);
  }
  return `${baseUrl}?${params.toString()}`;
}

function updateShareLinkDisplay() {
  const serial = document.getElementById('serialNumber').value.trim();
  const shareInput = document.getElementById('shareLinkDisplay');
  if (!shareInput || !serial) return;
  shareInput.value = buildShareableUrl(serial);
}

async function checkAndLoadSharedReportFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const reportId = params.get('id');
  if (!reportId) return false;

  const gasUrl = getActiveGasUrl();
  if (!gasUrl) {
    showToast(`⚠️ 偵測到傳簽單號 ${reportId}，請先於右上角「雲端設定」貼上 Google Apps Script 網址`);
    openModal('cloudConfigModal');
    return false;
  }

  showToast(`⏳ 正在從 Google 雲端載入單號 ${reportId} 之傳簽資料...`);
  try {
    const res = await fetch(`${gasUrl}?action=getReport&id=${encodeURIComponent(reportId)}`);
    const json = await res.json();
    if (json && json.status === 'success' && json.record) {
      populateFormData(json.record);
      setBaselineSnapshot(json.record);
      showToast(`✅ 已成功載入單號 ${reportId}！請填寫主管意見後點擊「儲存 & 複製傳簽連結」`);
      return true;
    } else {
      showToast(`⚠️ 雲端尚無單號 ${reportId} 之紀錄，將顯示本機資料`);
      return false;
    }
  } catch (err) {
    console.error('Load shared report error:', err);
    showToast('⚠️ 無法從雲端讀取單據：' + err.message);
    return false;
  }
}

/* ==========================================================================
   1. 自動將使用者手動填入的項目加入常用選單 (Datalist & 藥品字典持久化)
   ========================================================================== */
function getStoredCustomOptions() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.CUSTOM_OPTIONS);
    if (raw) {
      return JSON.parse(raw);
    }
  } catch (e) {
    // ignore
  }
  return {
    drugs: {},
    squads: [],
    drugNamesEn: [],
    units: [],
    specs: [],
    policeUnits: []
  };
}

function ensureDatalistOption(datalistId, value) {
  const cleanVal = String(value || '').trim();
  if (!cleanVal) return false;
  const datalist = document.getElementById(datalistId);
  if (!datalist) return false;

  const exists = Array.from(datalist.options).some((opt) => opt.value === cleanVal);
  if (!exists) {
    const opt = document.createElement('option');
    opt.value = cleanVal;
    datalist.appendChild(opt);
    return true;
  }
  return false;
}

function loadCustomOptionsFromStorage() {
  const custom = getStoredCustomOptions();

  if (custom.drugs && typeof custom.drugs === 'object') {
    Object.keys(custom.drugs).forEach((zhName) => {
      COMMON_DRUGS_DICT[zhName] = {
        ...(COMMON_DRUGS_DICT[zhName] || {}),
        ...custom.drugs[zhName]
      };
      ensureDatalistOption('commonDrugsZh', zhName);
    });
  }

  (custom.squads || []).forEach((v) => ensureDatalistOption('squadList', v));
  (custom.drugNamesEn || []).forEach((v) => ensureDatalistOption('commonDrugsEn', v));
  (custom.units || []).forEach((v) => ensureDatalistOption('unitList', v));
  (custom.specs || []).forEach((v) => ensureDatalistOption('commonSpecs', v));
  (custom.policeUnits || []).forEach((v) => ensureDatalistOption('commonPoliceUnits', v));
}

function learnUserCustomEntries() {
  const custom = getStoredCustomOptions();
  let updated = false;

  const addUnique = (arr, val, datalistId) => {
    const clean = String(val || '').trim();
    if (!clean) return;
    ensureDatalistOption(datalistId, clean);
    if (!arr.includes(clean)) {
      arr.push(clean);
      updated = true;
    }
  };

  const unitVal = document.getElementById('unit').value.trim();
  const zhVal = document.getElementById('drugNameZh').value.trim();
  const enVal = document.getElementById('drugNameEn').value.trim();
  const drugUnitVal = document.getElementById('drugUnit').value.trim();
  const specVal = document.getElementById('drugSpec').value.trim();
  const policeUnitVal = document.getElementById('policeUnit').value.trim();
  const checkedLevelEl = document.querySelector('input[name="controlLevel"]:checked');
  const levelVal = checkedLevelEl ? checkedLevelEl.value : '';

  addUnique(custom.squads, unitVal, 'squadList');
  addUnique(custom.drugNamesEn, enVal, 'commonDrugsEn');
  addUnique(custom.units, drugUnitVal, 'unitList');
  addUnique(custom.specs, specVal, 'commonSpecs');
  addUnique(custom.policeUnits, policeUnitVal, 'commonPoliceUnits');

  if (zhVal) {
    ensureDatalistOption('commonDrugsZh', zhVal);
    const existing = COMMON_DRUGS_DICT[zhVal] || {};
    const merged = {
      en: enVal || existing.en || '',
      level: levelVal || existing.level || '',
      spec: specVal || existing.spec || '',
      unit: drugUnitVal || existing.unit || ''
    };
    COMMON_DRUGS_DICT[zhVal] = merged;
    custom.drugs[zhVal] = merged;
    updated = true;
  }

  if (updated) {
    try {
      localStorage.setItem(STORAGE_KEYS.CUSTOM_OPTIONS, JSON.stringify(custom));
    } catch (e) {
      // ignore storage quota errors
    }
  }
}

/* ==========================================================================
   2. 初始化日期與流水號
   ========================================================================== */
function getTodayISO() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function generateSerialNumber(increment = false) {
  const now = new Date();
  const rocYear = now.getFullYear() - 1911;
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const dateKey = `${rocYear}${m}${d}`;

  let seqObj = { dateKey, count: 1 };
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.SERIAL_COUNTER);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.dateKey === dateKey) {
        seqObj.count = increment ? parsed.count + 1 : parsed.count;
      }
    }
    localStorage.setItem(STORAGE_KEYS.SERIAL_COUNTER, JSON.stringify(seqObj));
  } catch (e) {
    // ignore storage errors
  }

  const seqStr = String(seqObj.count).padStart(3, '0');
  return `HCFD-${dateKey}-${seqStr}`;
}

function initDefaultDatesAndSerial() {
  const reportDateEl = document.getElementById('reportDate');
  const occurDateEl = document.getElementById('occurDate');
  const serialEl = document.getElementById('serialNumber');

  if (!reportDateEl.value) reportDateEl.value = getTodayISO();
  if (!occurDateEl.value) occurDateEl.value = getTodayISO();
  if (!serialEl.value) serialEl.value = generateSerialNumber(false);
}

/* ==========================================================================
   3. 表單互動與連動事件綁定
   ========================================================================== */
function bindFormEvents() {
  const form = document.getElementById('incidentForm');

  form.addEventListener('input', () => {
    handleConditionalUI();
    syncPrintView();
    updateWorkflowProgressUI();
    checkDateConsistencyHint();
    saveDraftToStorage(true);
  });

  form.addEventListener('change', () => {
    handleConditionalUI();
    learnUserCustomEntries();
    syncPrintView();
    updateWorkflowProgressUI();
    checkDateConsistencyHint();
    saveDraftToStorage(true);
  });

  ['unit', 'drugNameZh', 'drugNameEn', 'drugUnit', 'drugSpec', 'policeUnit'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('blur', () => {
        learnUserCustomEntries();
      });
    }
  });

  // 重新產生流水號
  document.getElementById('btnRegenSerial').addEventListener('click', () => {
    document.getElementById('serialNumber').value = generateSerialNumber(true);
    syncPrintView();
    updateShareLinkDisplay();
    saveDraftToStorage(true);
    showToast('已產生新流水號：' + document.getElementById('serialNumber').value);
  });

  // 標題「損壞 / 遺失」設定為僅能單選其中一個，並連動「遺失/失竊報案證明」
  document.getElementById('typeDamage').addEventListener('change', (e) => {
    if (e.target.checked) {
      document.getElementById('typeLost').checked = false;
      document.getElementById('policeNA').checked = true;
      document.getElementById('policeReported').checked = false;
      syncPrintView();
      saveDraftToStorage(true);
    }
  });

  document.getElementById('typeLost').addEventListener('change', (e) => {
    if (e.target.checked) {
      document.getElementById('typeDamage').checked = false;
      document.getElementById('policeReported').checked = true;
      document.getElementById('policeNA').checked = false;
      syncPrintView();
      saveDraftToStorage(true);
    }
  });

  // 分隊長「責任判定」單選互斥（故意 / 過失 / 其他）與（能確定責任 / 無法確定責任）
  bindMutuallyExclusiveCheckboxes('chiefDutyType');
  bindMutuallyExclusiveCheckboxes('chiefDutyCert');

  // 當四級主管填寫意見時，若該主管日期欄為空，自動帶入今日日期方便簽核
  bindAutoSupervisorDate('chiefOpinion', 'chiefDate');
  bindAutoSupervisorDate('doctorOpinion', 'doctorDate');
  bindAutoSupervisorDate('emsOpinion', 'emsDate');
  bindAutoSupervisorDate('pharmacyAction', 'pharmacyDate');
  bindAutoSupervisorDate('pharmacyAdvice', 'pharmacyDate');

  // 藥品中文名稱選擇時，自動帶入英文、級別、規格、單位
  document.getElementById('drugNameZh').addEventListener('change', (e) => {
    const val = e.target.value.trim();
    if (COMMON_DRUGS_DICT[val]) {
      const info = COMMON_DRUGS_DICT[val];
      const enEl = document.getElementById('drugNameEn');
      const specEl = document.getElementById('drugSpec');
      const unitEl = document.getElementById('drugUnit');

      if (info.en) enEl.value = info.en;
      if (info.spec) specEl.value = info.spec;
      if (info.unit) unitEl.value = info.unit;

      if (info.level) {
        document.querySelectorAll('input[name="controlLevel"]').forEach((chk) => {
          chk.checked = (chk.value === info.level);
        });
      }
      syncPrintView();
      saveDraftToStorage(true);
    }
  });

  // 報告內容快速範本按鈕
  document.getElementById('btnTplDamage').addEventListener('click', () => {
    const unit = document.getElementById('unit').value || '○○分隊';
    const reporter = document.getElementById('reporter').value || '隊員○○○';
    const drug = document.getElementById('drugNameZh').value || '管制藥品';
    const qty = document.getElementById('drugQty').value || '1';
    const drugUnit = document.getElementById('drugUnit').value || '支';
    const noCase = document.getElementById('noCaseNumber').checked;
    const caseNote = noCase ? '（本次為分隊廳舍內例行清點/交接，故無救護案件編號）' : '';

    document.getElementById('reportContent').value =
      `一、本分隊（${unit}）${reporter}於上述發生時間執行勤務／藥品清點時${caseNote}，不慎發生「${drug}」${qty}${drugUnit}安瓿破損情事。\n` +
      `二、事發當下立即保留破損安瓿殘品、外盒並拍照存證，同時同步通報分隊長及醫院藥劑科，並登載於收支結存簿冊及使用紀錄單（姓名欄註記「破損」）。`;

    if (!document.getElementById('improve1').value) {
      document.getElementById('improve1').value = '加強出勤救護藥箱防撞緩衝固定，取用安瓿時雙手確認握穩。';
      document.getElementById('improve2').value = '落實交接班與出勤前後雙人覆核清點機制。';
    }
    syncPrintView();
    updateWorkflowProgressUI();
    saveDraftToStorage(true);
    showToast('已套用「藥品破損」報告與改善方案範本');
  });

  document.getElementById('btnTplLost').addEventListener('click', () => {
    const unit = document.getElementById('unit').value || '○○分隊';
    const reporter = document.getElementById('reporter').value || '隊員○○○';
    const drug = document.getElementById('drugNameZh').value || '管制藥品';
    const qty = document.getElementById('drugQty').value || '1';
    const drugUnit = document.getElementById('drugUnit').value || '支';

    document.getElementById('reportContent').value =
      `一、本分隊（${unit}）${reporter}於上述時間返隊清點救護車管制藥品時，發現「${drug}」短少${qty}${drugUnit}。\n` +
      `二、立即保留現場並發動全隊同仁搜尋未果，當下即同步通報分隊長、緊急救護科及醫院藥劑科，並立即前往轄區警察機關完成報案程序取得受（處）理案件證明單。`;

    if (!document.getElementById('improve1').value) {
      document.getElementById('improve1').value = '救護現場使用管制藥品後，空安瓿與未用藥品立即歸入專用上鎖藥盒。';
      document.getElementById('improve2').value = '離開救護現場及醫院交接前，由主副手雙人再次清點管制藥品數量。';
      document.getElementById('improve3').value = '強化每班交接清點紀錄與隨車藥箱上鎖管理。';
    }
    syncPrintView();
    updateWorkflowProgressUI();
    saveDraftToStorage(true);
    showToast('已套用「藥品遺失」報告與改善方案範本');
  });

  // 表單送出 (儲存雲端並複製傳簽連結)
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    learnUserCustomEntries();
    await handleFormSubmitAndCopyLink();
  });

  document.getElementById('btnSaveAndCopyLink').addEventListener('click', async () => {
    learnUserCustomEntries();
    await handleFormSubmitAndCopyLink();
  });
}

function bindMutuallyExclusiveCheckboxes(groupName) {
  const boxes = document.querySelectorAll(`input[name="${groupName}"]`);
  boxes.forEach((box) => {
    box.addEventListener('change', (e) => {
      if (e.target.checked) {
        boxes.forEach((other) => {
          if (other !== e.target) other.checked = false;
        });
        syncPrintView();
        updateWorkflowProgressUI();
        saveDraftToStorage(true);
      }
    });
  });
}

function bindAutoSupervisorDate(inputId, dateId) {
  const inputEl = document.getElementById(inputId);
  const dateEl = document.getElementById(dateId);
  if (!inputEl || !dateEl) return;
  inputEl.addEventListener('input', () => {
    if (inputEl.value.trim() && !dateEl.value) {
      dateEl.value = getTodayISO();
      syncPrintView();
    }
  });
}

function handleConditionalUI() {
  const noCaseChk = document.getElementById('noCaseNumber');
  const caseInput = document.getElementById('caseNumber');
  if (noCaseChk.checked) {
    caseInput.value = '';
    caseInput.disabled = true;
    caseInput.placeholder = '已勾選「無案件編號」（請於報告內容說明）';
  } else {
    caseInput.disabled = false;
    caseInput.placeholder = '請輸入救護案件編號';
  }

  const otherPlaceChk = document.getElementById('occurPlaceOtherChk');
  const otherPlaceText = document.getElementById('occurPlaceOtherText');
  otherPlaceText.style.display = otherPlaceChk.checked ? 'block' : 'none';
}

function checkDateConsistencyHint() {
  const occurDate = document.getElementById('occurDate').value;
  const policeReported = document.getElementById('policeReported').checked;
  const policeDate = document.getElementById('policeDate').value;
  const banner = document.getElementById('validationBanner');

  if (policeReported && occurDate && policeDate && occurDate !== policeDate) {
    banner.innerHTML = `⚠️ <strong>日期一致性提醒：</strong>依表單底部說明，「減損（發生）日期 (${occurDate})」為唯一基準，使用紀錄單、簿冊、盤點表及「報案證明單日期 (${policeDate})」須一致，請再次確認。`;
    banner.classList.add('show');
  } else {
    banner.classList.remove('show');
  }
}

function updateWorkflowProgressUI() {
  const data = collectFormData();

  const isReporterDone = Boolean(
    data.incidentTypes.length > 0 &&
    data.unit &&
    data.drugNameZh &&
    data.reporter &&
    data.reportContent.trim()
  );
  const isChiefDone = Boolean(
    data.chiefOpinion.trim() ||
    data.chiefDutyTypes.length > 0 ||
    data.chiefDutyCerts.length > 0
  );
  const isDoctorDone = Boolean(data.doctorOpinion.trim());
  const isEmsDone = Boolean(data.emsOpinion.trim());
  const isPharmacyDone = Boolean(data.pharmacyAction.trim() || data.pharmacyAdvice.trim());

  setStepChipState('stepChipReporter', '① 事故人員填報', isReporterDone);
  setStepChipState('stepChipChief', '② 分隊長意見', isChiefDone);
  setStepChipState('stepChipDoctor', '③ 醫療指導醫師', isDoctorDone);
  setStepChipState('stepChipEms', '④ 緊急救護科主管', isEmsDone);
  setStepChipState('stepChipPharmacy', '⑤ 醫院藥劑科主任', isPharmacyDone);
}

function setStepChipState(chipId, label, isDone) {
  const el = document.getElementById(chipId);
  if (!el) return;
  if (isDone) {
    el.classList.add('done');
    el.textContent = `${label} ✓`;
  } else {
    el.classList.remove('done');
    el.textContent = label;
  }
}

/* ==========================================================================
   4. 照片上傳、拖曳與自動壓縮預覽 (照片一 / 照片二)
   ========================================================================== */
function bindPhotoUploaders() {
  setupSinglePhotoSlot(1, 'dropzone1', 'photoInput1', 'previewImg1', 'btnRemovePhoto1');
  setupSinglePhotoSlot(2, 'dropzone2', 'photoInput2', 'previewImg2', 'btnRemovePhoto2');
}

function setupSinglePhotoSlot(slotIndex, dropzoneId, inputId, imgId, removeBtnId) {
  const dropzone = document.getElementById(dropzoneId);
  const fileInput = document.getElementById(inputId);
  const previewImg = document.getElementById(imgId);
  const removeBtn = document.getElementById(removeBtnId);
  const stateKey = `photo${slotIndex}`;

  dropzone.addEventListener('click', (e) => {
    if (e.target === removeBtn) return;
    fileInput.click();
  });

  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });

  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('dragover');
  });

  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      processImageFile(e.dataTransfer.files[0], stateKey, dropzone, previewImg);
    }
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) {
      processImageFile(e.target.files[0], stateKey, dropzone, previewImg);
    }
  });

  removeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    photoState[stateKey] = '';
    previewImg.src = '';
    fileInput.value = '';
    dropzone.classList.remove('has-image');
    saveDraftToStorage(true);
    showToast(`已移除照片${slotIndex === 1 ? '一' : '二'}`);
  });
}

function processImageFile(file, stateKey, dropzone, previewImg) {
  if (!file.type.startsWith('image/')) {
    showToast('⚠️ 請選擇圖片檔案 (JPG / PNG / HEIC)');
    return;
  }

  const reader = new FileReader();
  reader.onload = (event) => {
    const img = new Image();
    img.onload = () => {
      const MAX_SIZE = 1200;
      let width = img.width;
      let height = img.height;

      if (width > height && width > MAX_SIZE) {
        height = Math.round((height * MAX_SIZE) / width);
        width = MAX_SIZE;
      } else if (height > MAX_SIZE) {
        width = Math.round((width * MAX_SIZE) / height);
        height = MAX_SIZE;
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);

      const compressedDataUrl = canvas.toDataURL('image/jpeg', 0.84);
      photoState[stateKey] = compressedDataUrl;
      previewImg.src = compressedDataUrl;
      dropzone.classList.add('has-image');
      saveDraftToStorage(true);
      showToast('✅ 照片已載入並最佳化');
    };
    img.src = event.target.result;
  };
  reader.readAsDataURL(file);
}

/* ==========================================================================
   5. A4 紙本列印檢視同步（將使用者與主管填入的值套用「藍色」.user-val）與「一式三聯」產生器
   ========================================================================== */
function blueSpan(text) {
  if (text === undefined || text === null || String(text).trim() === '') return '';
  return `<span class="user-val">${escapeHtml(String(text))}</span>`;
}

function chkOptionHtml(checked, labelText) {
  if (checked) {
    return `<span class="user-val">☑${escapeHtml(labelText)}</span>`;
  }
  return `□${escapeHtml(labelText)}`;
}

function formatROCDateHtml(isoDateStr) {
  if (!isoDateStr) return '　　年　月　日';
  const parts = isoDateStr.split('-');
  if (parts.length !== 3) return blueSpan(isoDateStr);
  const rocY = parseInt(parts[0], 10) - 1911;
  const m = parseInt(parts[1], 10);
  const d = parseInt(parts[2], 10);
  return `${blueSpan(rocY)} 年 ${blueSpan(m)} 月 ${blueSpan(d)} 日`;
}

function formatSupervisorDateSlotHtml(isoDateStr) {
  if (!isoDateStr) {
    return '日期：<span class="date-blank"></span>年<span class="date-blank"></span>月<span class="date-blank"></span>日';
  }
  return `日期：${formatROCDateHtml(isoDateStr)}`;
}

function formatROCDateTimeHtml(isoDateStr, timeStr) {
  if (!isoDateStr) return '　　年　月　日　時　分';
  const parts = isoDateStr.split('-');
  const rocY = parseInt(parts[0], 10) - 1911;
  const m = parseInt(parts[1], 10);
  const d = parseInt(parts[2], 10);
  let hrHtml = '　';
  let minHtml = '　';
  if (timeStr && timeStr.includes(':')) {
    const tParts = timeStr.split(':');
    hrHtml = blueSpan(tParts[0]);
    minHtml = blueSpan(tParts[1]);
  }
  return `${blueSpan(rocY)} 年 ${blueSpan(m)} 月 ${blueSpan(d)} 日 ${hrHtml} 時 ${minHtml} 分`;
}

function syncPrintView() {
  // 1. 標題：□損壞 □遺失
  const isDamage = document.getElementById('typeDamage').checked;
  const isLost = document.getElementById('typeLost').checked;
  document.getElementById('printTitleIncidentType').innerHTML =
    `${chkOptionHtml(isDamage, '損壞')} ${chkOptionHtml(isLost, '遺失')}`;

  // 2. 單位、填表日期、編號
  const unitVal = document.getElementById('unit').value.trim();
  document.getElementById('print_unit').innerHTML = unitVal ? blueSpan(unitVal) : '○○分隊';
  document.getElementById('print_reportDate').innerHTML = formatROCDateHtml(document.getElementById('reportDate').value);

  const serialVal = document.getElementById('serialNumber').value.trim();
  document.getElementById('print_serialNumber').innerHTML =
    serialVal ? blueSpan(serialVal) : '(系統自動產生流水號)';

  // 3. 案件編號 & 救護紀錄表號
  const noCase = document.getElementById('noCaseNumber').checked;
  const caseNo = document.getElementById('caseNumber').value.trim();
  if (noCase) {
    document.getElementById('print_caseNumber').innerHTML = chkOptionHtml(true, '無案件編號');
  } else {
    document.getElementById('print_caseNumber').innerHTML =
      caseNo ? `${blueSpan(caseNo)}　□無案件編號` : '□無案件編號';
  }
  document.getElementById('print_emsRecordNumber').innerHTML =
    blueSpan(document.getElementById('emsRecordNumber').value.trim());

  // 4. 發生時間 & 發生地點
  document.getElementById('print_occurDateTime').innerHTML = formatROCDateTimeHtml(
    document.getElementById('occurDate').value,
    document.getElementById('occurTime').value
  );

  const selectedPlaces = Array.from(document.querySelectorAll('input[name="occurPlace"]:checked')).map(el => el.value);
  const otherPlaceText = document.getElementById('occurPlaceOtherText').value.trim();
  document.getElementById('print_occurPlace').innerHTML =
    `${chkOptionHtml(selectedPlaces.includes('救護現場'), '救護現場')} ${chkOptionHtml(selectedPlaces.includes('救護車上'), '救護車上')}<br/>` +
    `${chkOptionHtml(selectedPlaces.includes('分隊'), '分隊')} ${chkOptionHtml(selectedPlaces.includes('其他'), '其他：')}${blueSpan(otherPlaceText)}`;

  // 5. 藥品名稱、管制級別、數量／單位
  document.getElementById('print_drugNameZh').innerHTML =
    `中文：${blueSpan(document.getElementById('drugNameZh').value.trim())}`;
  document.getElementById('print_drugNameEn').innerHTML =
    `英文：${blueSpan(document.getElementById('drugNameEn').value.trim())}`;

  const selectedLevels = Array.from(document.querySelectorAll('input[name="controlLevel"]:checked')).map(el => el.value);
  document.getElementById('print_controlLevel').innerHTML =
    `${chkOptionHtml(selectedLevels.includes('一級'), '一級')} ${chkOptionHtml(selectedLevels.includes('二級'), '二級')} ` +
    `${chkOptionHtml(selectedLevels.includes('三級'), '三級')} ${chkOptionHtml(selectedLevels.includes('四級'), '四級')} ` +
    `${chkOptionHtml(selectedLevels.includes('非管制藥'), '非管制藥')}`;

  const qty = document.getElementById('drugQty').value.trim();
  const dUnit = document.getElementById('drugUnit').value.trim();
  document.getElementById('print_qtyUnit').innerHTML =
    `數量：${qty ? blueSpan(qty) : '　　'}　　單位：${dUnit ? blueSpan(dUnit) : '　　'}`;

  // 6. 規格、批號、效期
  document.getElementById('print_drugSpec').innerHTML = blueSpan(document.getElementById('drugSpec').value.trim());
  document.getElementById('print_batchNumber').innerHTML = blueSpan(document.getElementById('batchNumber').value.trim());
  document.getElementById('print_expiryDate').innerHTML = blueSpan(document.getElementById('expiryDate').value);

  // 7. 保管人、報告者、聯絡電話
  document.getElementById('print_custodian').innerHTML = blueSpan(document.getElementById('custodian').value.trim());
  document.getElementById('print_reporter').innerHTML = blueSpan(document.getElementById('reporter').value.trim());
  document.getElementById('print_contactPhone').innerHTML = blueSpan(document.getElementById('contactPhone').value.trim());

  // 8. 報告內容
  document.getElementById('print_reportContent').innerHTML = blueSpan(document.getElementById('reportContent').value);

  // 9. 遺失／失竊報案證明
  const pNA = document.getElementById('policeNA').checked;
  const pRep = document.getElementById('policeReported').checked;
  const pUnit = document.getElementById('policeUnit').value.trim();
  const pDate = document.getElementById('policeDate').value
    ? formatROCDateHtml(document.getElementById('policeDate').value)
    : '　　年　月　日';
  const pDoc = document.getElementById('policeDocNo').value.trim();

  document.getElementById('print_policeReport').innerHTML =
    `遺失／失竊報案證明：${chkOptionHtml(pNA, '不適用(損壞)')}　${chkOptionHtml(pRep, '已報案：')}受理單位 ${pUnit ? blueSpan(pUnit) : '　　　　'}　日期 ${pDate}　文號 ${pDoc ? blueSpan(pDoc) : '　　　　'}`;

  // 10. 改善方案
  const imp1 = document.getElementById('improve1').value.trim();
  const imp2 = document.getElementById('improve2').value.trim();
  const imp3 = document.getElementById('improve3').value.trim();
  document.getElementById('print_improvements').innerHTML =
    `<div>1. ${blueSpan(imp1)}</div><div>2. ${blueSpan(imp2)}</div><div>3. ${blueSpan(imp3)}</div>`;

  // 11. 分隊長 主管意見（電子填寫值套用藍色，簽章維持紙本蓋章空白）
  const chiefDutyTypes = Array.from(document.querySelectorAll('input[name="chiefDutyType"]:checked')).map(el => el.value);
  const chiefDutyOther = document.getElementById('chiefDutyOther').value.trim();
  const chiefDutyCerts = Array.from(document.querySelectorAll('input[name="chiefDutyCert"]:checked')).map(el => el.value);

  document.getElementById('print_chiefDutyLeft').innerHTML =
    `責任判定：${chkOptionHtml(chiefDutyTypes.includes('故意'), '故意')}　` +
    `${chkOptionHtml(chiefDutyTypes.includes('過失'), '過失')}　` +
    `${chkOptionHtml(chiefDutyTypes.includes('其他'), '其他：')}${chiefDutyOther ? blueSpan(chiefDutyOther) : '＿＿＿＿'}`;

  document.getElementById('print_chiefDutyRight').innerHTML =
    `${chkOptionHtml(chiefDutyCerts.includes('能確定責任'), '能確定責任')}　` +
    `${chkOptionHtml(chiefDutyCerts.includes('無法確定責任'), '無法確定責任')}`;

  document.getElementById('print_chiefOpinion').innerHTML =
    `意見：${blueSpan(document.getElementById('chiefOpinion').value.trim())}`;
  document.getElementById('print_chiefDate').innerHTML =
    formatSupervisorDateSlotHtml(document.getElementById('chiefDate').value);

  // 12. 醫療指導 醫師意見
  document.getElementById('print_doctorOpinion').innerHTML =
    `意見：${blueSpan(document.getElementById('doctorOpinion').value.trim())}`;
  document.getElementById('print_doctorDate').innerHTML =
    formatSupervisorDateSlotHtml(document.getElementById('doctorDate').value);

  // 13. 緊急救護科 主管意見
  document.getElementById('print_emsOpinion').innerHTML =
    `意見：${blueSpan(document.getElementById('emsOpinion').value.trim())}`;
  document.getElementById('print_emsDate').innerHTML =
    formatSupervisorDateSlotHtml(document.getElementById('emsDate').value);

  // 14. 醫院 藥劑科主任 意見
  document.getElementById('print_pharmacyAction').innerHTML =
    `處理方式：${blueSpan(document.getElementById('pharmacyAction').value.trim())}`;
  document.getElementById('print_pharmacyAdvice').innerHTML =
    `其他建議：${blueSpan(document.getElementById('pharmacyAdvice').value.trim())}`;
  document.getElementById('print_pharmacyDate').innerHTML =
    formatSupervisorDateSlotHtml(document.getElementById('pharmacyDate').value);
}

function triggerPrintA4() {
  learnUserCustomEntries();
  syncPrintView();
  const mode = document.getElementById('printCopyMode').value;
  const cloneContainer = document.getElementById('triplicatePrintCloneContainer');
  const mainSheet = document.getElementById('mainFormSheet');

  cloneContainer.innerHTML = '';

  if (mode === 'triplicate') {
    document.getElementById('currentCopyBadge').textContent = '第一聯：醫院藥劑科留存';
    cloneContainer.classList.add('active-triplicate');

    const copies = [
      '第二聯：消防局緊急救護科留存',
      '第三聯：分隊留存'
    ];

    copies.forEach((badgeTitle) => {
      const clone = mainSheet.cloneNode(true);
      clone.removeAttribute('id');
      const badge = clone.querySelector('#currentCopyBadge');
      if (badge) {
        badge.removeAttribute('id');
        badge.textContent = badgeTitle;
      }
      cloneContainer.appendChild(clone);
    });
  } else {
    document.getElementById('currentCopyBadge').textContent = '一式三聯標準本';
    cloneContainer.classList.remove('active-triplicate');
  }

  setTimeout(() => {
    window.print();
  }, 120);
}

/* ==========================================================================
   6. 資料序列化、本機草稿儲存、多人傳簽差分比對 (Dirty Fields)、JSON 匯出匯入
   ========================================================================== */
let baselineFormDataSnapshot = null;

function setBaselineSnapshot(data) {
  const source = data || collectFormData();
  baselineFormDataSnapshot = JSON.parse(JSON.stringify(source));
}

function getDirtyFields(currentData) {
  if (!baselineFormDataSnapshot) {
    return Object.keys(currentData);
  }
  const dirty = [];
  for (const key in currentData) {
    if (key === 'savedAt' || key === 'updatedAt') continue;
    const curVal = currentData[key];
    const baseVal = baselineFormDataSnapshot[key];

    const isDiff = (Array.isArray(curVal) || Array.isArray(baseVal))
      ? JSON.stringify(curVal || []) !== JSON.stringify(baseVal || [])
      : String(curVal ?? '').trim() !== String(baseVal ?? '').trim();

    if (isDiff) {
      dirty.push(key);
    }
  }
  return dirty;
}

function collectFormData() {
  const getCheckedValues = (name) =>
    Array.from(document.querySelectorAll(`input[name="${name}"]:checked`)).map((el) => el.value);

  return {
    serialNumber: document.getElementById('serialNumber').value.trim(),
    incidentTypes: getCheckedValues('incidentType'),
    unit: document.getElementById('unit').value.trim(),
    reportDate: document.getElementById('reportDate').value,
    caseNumber: document.getElementById('caseNumber').value.trim(),
    noCaseNumber: document.getElementById('noCaseNumber').checked,
    emsRecordNumber: document.getElementById('emsRecordNumber').value.trim(),
    occurDate: document.getElementById('occurDate').value,
    occurTime: document.getElementById('occurTime').value,
    occurPlaces: getCheckedValues('occurPlace'),
    occurPlaceOtherText: document.getElementById('occurPlaceOtherText').value.trim(),
    drugNameZh: document.getElementById('drugNameZh').value.trim(),
    drugNameEn: document.getElementById('drugNameEn').value.trim(),
    controlLevels: getCheckedValues('controlLevel'),
    drugQty: document.getElementById('drugQty').value.trim(),
    drugUnit: document.getElementById('drugUnit').value.trim(),
    drugSpec: document.getElementById('drugSpec').value.trim(),
    batchNumber: document.getElementById('batchNumber').value.trim(),
    expiryDate: document.getElementById('expiryDate').value,
    custodian: document.getElementById('custodian').value.trim(),
    reporter: document.getElementById('reporter').value.trim(),
    contactPhone: document.getElementById('contactPhone').value.trim(),
    reportContent: document.getElementById('reportContent').value,
    photo1: photoState.photo1,
    photo2: photoState.photo2,
    policeStatuses: getCheckedValues('policeStatus'),
    policeUnit: document.getElementById('policeUnit').value.trim(),
    policeDate: document.getElementById('policeDate').value,
    policeDocNo: document.getElementById('policeDocNo').value.trim(),
    improve1: document.getElementById('improve1').value.trim(),
    improve2: document.getElementById('improve2').value.trim(),
    improve3: document.getElementById('improve3').value.trim(),
    // 四級主管意見與日期欄位
    chiefDutyTypes: getCheckedValues('chiefDutyType'),
    chiefDutyOther: document.getElementById('chiefDutyOther').value.trim(),
    chiefDutyCerts: getCheckedValues('chiefDutyCert'),
    chiefOpinion: document.getElementById('chiefOpinion').value,
    chiefDate: document.getElementById('chiefDate').value,
    doctorOpinion: document.getElementById('doctorOpinion').value,
    doctorDate: document.getElementById('doctorDate').value,
    emsOpinion: document.getElementById('emsOpinion').value,
    emsDate: document.getElementById('emsDate').value,
    pharmacyAction: document.getElementById('pharmacyAction').value.trim(),
    pharmacyAdvice: document.getElementById('pharmacyAdvice').value.trim(),
    pharmacyDate: document.getElementById('pharmacyDate').value,
    savedAt: new Date().toISOString()
  };
}

function populateFormData(data) {
  if (!data) return;

  const setCheckboxes = (name, values = []) => {
    document.querySelectorAll(`input[name="${name}"]`).forEach((chk) => {
      chk.checked = Array.isArray(values) && values.includes(chk.value);
    });
  };

  if (data.serialNumber) document.getElementById('serialNumber').value = data.serialNumber;
  setCheckboxes('incidentType', data.incidentTypes);
  document.getElementById('unit').value = data.unit || '';
  document.getElementById('reportDate').value = data.reportDate || getTodayISO();
  document.getElementById('caseNumber').value = data.caseNumber || '';
  document.getElementById('noCaseNumber').checked = Boolean(data.noCaseNumber);
  document.getElementById('emsRecordNumber').value = data.emsRecordNumber || '';
  document.getElementById('occurDate').value = data.occurDate || getTodayISO();
  document.getElementById('occurTime').value = data.occurTime || '';
  setCheckboxes('occurPlace', data.occurPlaces);
  document.getElementById('occurPlaceOtherText').value = data.occurPlaceOtherText || '';
  document.getElementById('drugNameZh').value = data.drugNameZh || '';
  document.getElementById('drugNameEn').value = data.drugNameEn || '';
  setCheckboxes('controlLevel', data.controlLevels);
  document.getElementById('drugQty').value = data.drugQty || '';
  document.getElementById('drugUnit').value = data.drugUnit || '';
  document.getElementById('drugSpec').value = data.drugSpec || '';
  document.getElementById('batchNumber').value = data.batchNumber || '';
  document.getElementById('expiryDate').value = data.expiryDate || '';
  document.getElementById('custodian').value = data.custodian || '';
  document.getElementById('reporter').value = data.reporter || '';
  document.getElementById('contactPhone').value = data.contactPhone || '';
  document.getElementById('reportContent').value = data.reportContent || '';

  if (data.photo1) {
    photoState.photo1 = data.photo1;
    restorePhotoPreview(1, photoState.photo1);
  } else if (data.photo1 === '' && data.photo1Cleared) {
    photoState.photo1 = '';
    restorePhotoPreview(1, '');
  }
  if (data.photo2) {
    photoState.photo2 = data.photo2;
    restorePhotoPreview(2, photoState.photo2);
  } else if (data.photo2 === '' && data.photo2Cleared) {
    photoState.photo2 = '';
    restorePhotoPreview(2, '');
  }

  setCheckboxes('policeStatus', data.policeStatuses);
  document.getElementById('policeUnit').value = data.policeUnit || '';
  document.getElementById('policeDate').value = data.policeDate || '';
  document.getElementById('policeDocNo').value = data.policeDocNo || '';

  document.getElementById('improve1').value = data.improve1 || '';
  document.getElementById('improve2').value = data.improve2 || '';
  document.getElementById('improve3').value = data.improve3 || '';

  // 還原四級主管意見與日期
  setCheckboxes('chiefDutyType', data.chiefDutyTypes);
  document.getElementById('chiefDutyOther').value = data.chiefDutyOther || '';
  setCheckboxes('chiefDutyCert', data.chiefDutyCerts);
  document.getElementById('chiefOpinion').value = data.chiefOpinion || '';
  document.getElementById('chiefDate').value = data.chiefDate || '';
  document.getElementById('doctorOpinion').value = data.doctorOpinion || '';
  document.getElementById('doctorDate').value = data.doctorDate || '';
  document.getElementById('emsOpinion').value = data.emsOpinion || '';
  document.getElementById('emsDate').value = data.emsDate || '';
  document.getElementById('pharmacyAction').value = data.pharmacyAction || '';
  document.getElementById('pharmacyAdvice').value = data.pharmacyAdvice || '';
  document.getElementById('pharmacyDate').value = data.pharmacyDate || '';

  handleConditionalUI();
  learnUserCustomEntries();
  syncPrintView();
  updateWorkflowProgressUI();
  updateShareLinkDisplay();
  checkDateConsistencyHint();
}

function restorePhotoPreview(slotIndex, base64Str) {
  const dropzone = document.getElementById(`dropzone${slotIndex}`);
  const previewImg = document.getElementById(`previewImg${slotIndex}`);
  if (base64Str) {
    previewImg.src = base64Str;
    dropzone.classList.add('has-image');
  } else {
    previewImg.src = '';
    dropzone.classList.remove('has-image');
  }
}

function saveDraftToStorage(isAuto = false) {
  try {
    if (!isAuto) {
      learnUserCustomEntries();
    }
    const data = collectFormData();
    localStorage.setItem(STORAGE_KEYS.DRAFT, JSON.stringify(data));
    const nowStr = new Date().toLocaleTimeString('zh-TW', { hour12: false });
    document.getElementById('autoSaveTimestamp').textContent = `草稿已自動儲存 (${nowStr})`;
    if (!isAuto) {
      showToast('💾 草稿已儲存至本機瀏覽器');
    }
  } catch (e) {
    console.warn('Draft save warning:', e);
  }
}

function loadDraftFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.DRAFT);
    if (raw) {
      const data = JSON.parse(raw);
      populateFormData(data);
    }
  } catch (e) {
    console.warn('Load draft error:', e);
  }
}

/* ==========================================================================
   7. 雲端傳簽儲存 (Google Apps Script) 與專屬傳簽連結複製
   ========================================================================== */
function validateFormBeforeSubmit(data) {
  const missing = [];
  if (data.incidentTypes.length === 0) missing.push('標題事故類別（損壞或遺失）');
  if (!data.unit) missing.push('單位');
  if (!data.reportDate) missing.push('填表日期');
  if (!data.noCaseNumber && !data.caseNumber) missing.push('案件編號（若無請勾選「無案件編號」）');
  if (!data.occurDate || !data.occurTime) missing.push('發生時間');
  if (data.occurPlaces.length === 0) missing.push('發生地點');
  if (!data.drugNameZh) missing.push('藥品中文名稱');
  if (data.controlLevels.length === 0) missing.push('管制級別');
  if (!data.drugQty || !data.drugUnit) missing.push('數量／單位');
  if (!data.custodian) missing.push('保管人');
  if (!data.reporter) missing.push('報告者');
  if (!data.contactPhone) missing.push('聯絡電話');
  if (!data.reportContent.trim()) missing.push('報告內容');

  return missing;
}

function computeLocalProgressSummary(d) {
  const done = [];
  if (d.chiefOpinion || (d.chiefDutyTypes && d.chiefDutyTypes.length) || (d.chiefDutyCerts && d.chiefDutyCerts.length)) done.push('分隊長');
  if (d.doctorOpinion) done.push('指導醫師');
  if (d.emsOpinion) done.push('救護科');
  if (d.pharmacyAction || d.pharmacyAdvice) done.push('藥劑科');
  if (done.length === 0) return '待主管簽核 (0/4)';
  if (done.length === 4) return '✅ 全部主管已填畢 (4/4 可列印)';
  return `傳簽中 (${done.length}/4：${done.join('、')})`;
}

async function handleFormSubmitAndCopyLink() {
  const data = collectFormData();
  const missingFields = validateFormBeforeSubmit(data);
  const banner = document.getElementById('validationBanner');

  if (missingFields.length > 0) {
    banner.innerHTML = `❌ <strong>請補齊以下基本欄位後再行儲存傳簽：</strong>${missingFields.join('、')}`;
    banner.classList.add('show');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    showToast('⚠️ 尚有必填欄位未填寫');
    return;
  }

  banner.classList.remove('show');
  const dirtyFields = getDirtyFields(data);
  data.signProgress = computeLocalProgressSummary(data);
  saveRecordToLocalHistory(data);

  const gasUrl = getActiveGasUrl();
  if (!gasUrl) {
    openModal('cloudConfigModal');
    showToast('⚠️ 請先完成「Google 雲端設定」，即可產生跨裝置主管傳簽連結！');
    return;
  }

  const submitBtn = document.getElementById('btnSubmitCloud');
  const shareBtn = document.getElementById('btnSaveAndCopyLink');
  const origSubmitText = submitBtn.innerHTML;
  const origShareText = shareBtn.innerHTML;

  submitBtn.disabled = true;
  shareBtn.disabled = true;
  submitBtn.innerHTML = '⏳ 正在同步雲端傳簽資料...';
  shareBtn.innerHTML = '⏳ 正在同步雲端...';

  try {
    const response = await fetch(gasUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        action: 'submitReport',
        payload: data,
        dirtyFields: dirtyFields
      })
    });

    const result = await response.json();
    if (result && result.status === 'success') {
      if (result.serialNumber) {
        document.getElementById('serialNumber').value = result.serialNumber;
        data.serialNumber = result.serialNumber;
      }
      if (result.record) {
        populateFormData(result.record);
        setBaselineSnapshot(result.record);
        saveRecordToLocalHistory(result.record);
      } else {
        data.signProgress = result.signProgress || computeLocalProgressSummary(data);
        saveRecordToLocalHistory(data);
        setBaselineSnapshot(data);
      }
      syncPrintView();
      updateWorkflowProgressUI();

      const shareUrl = buildShareableUrl(data.serialNumber);
      document.getElementById('shareLinkDisplay').value = shareUrl;

      // 更新瀏覽器網址列方便直接重新整理或分享
      window.history.replaceState({}, '', `?id=${encodeURIComponent(data.serialNumber)}`);

      try {
        await navigator.clipboard.writeText(shareUrl);
        showToast('🎉 已成功儲存至雲端並自動同步所有主管最新意見！已複製傳簽連結。');
      } catch (clipErr) {
        showToast('🎉 已成功儲存至雲端並自動同步所有主管最新意見！請複製上方傳簽連結。');
      }
    } else {
      throw new Error((result && result.message) || '雲端回傳未知錯誤');
    }
  } catch (err) {
    console.error('GAS upload error:', err);
    showToast('⚠️ 雲端同步失敗（已先保存於本機）：' + err.message);
  } finally {
    submitBtn.disabled = false;
    shareBtn.disabled = false;
    submitBtn.innerHTML = origSubmitText;
    shareBtn.innerHTML = origShareText;
  }
}

function getLocalHistoryList() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.HISTORY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function saveRecordToLocalHistory(record) {
  const list = getLocalHistoryList();
  const idx = list.findIndex((item) => item.serialNumber === record.serialNumber);
  if (idx >= 0) {
    list[idx] = record;
  } else {
    list.unshift(record);
  }
  const trimmed = list.slice(0, 30);
  try {
    localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify(trimmed));
  } catch (e) {
    const lightList = trimmed.map((r, i) => (i > 5 ? { ...r, photo1: '', photo2: '' } : r));
    localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify(lightList));
  }
}

function renderHistoryTable() {
  const tbody = document.getElementById('historyTableBody');
  const list = getLocalHistoryList();

  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:24px; color:var(--text-muted);">目前尚無已儲存的事故報告單紀錄</td></tr>`;
    return;
  }

  tbody.innerHTML = list
    .map((item, idx) => {
      const typeStr = (item.incidentTypes || []).join('/') || '未勾選';
      const badgeClass = typeStr.includes('遺失') ? 'badge-lost' : 'badge-damage';
      const progressText = item.signProgress || computeLocalProgressSummary(item);
      return `
        <tr>
          <td style="font-weight:700; color:var(--user-blue);">${escapeHtml(item.serialNumber || '')}</td>
          <td>${escapeHtml(item.reportDate || '')}</td>
          <td>${escapeHtml(item.unit || '')}</td>
          <td><span class="badge-type ${badgeClass}">${escapeHtml(typeStr)}</span></td>
          <td>${escapeHtml(item.drugNameZh || '')}</td>
          <td>${escapeHtml(item.reporter || '')}</td>
          <td style="font-weight:600;">${escapeHtml(progressText)}</td>
          <td>
            <button type="button" class="btn-mini" data-load-idx="${idx}">載入表單</button>
            <button type="button" class="btn-mini" style="color:#DC2626; border-color:#FCA5A5; background:#FEF2F2;" data-del-idx="${idx}">刪除</button>
          </td>
        </tr>
      `;
    })
    .join('');

  tbody.querySelectorAll('[data-load-idx]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const index = parseInt(btn.getAttribute('data-load-idx'), 10);
      const record = list[index];
      if (record) {
        populateFormData(record);
        closeModal('historyModal');
        showToast(`📂 已載入單號 ${record.serialNumber} 之報告單`);
      }
    });
  });

  tbody.querySelectorAll('[data-del-idx]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const index = parseInt(btn.getAttribute('data-del-idx'), 10);
      list.splice(index, 1);
      localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify(list));
      renderHistoryTable();
      showToast('🗑️ 已刪除該筆本機紀錄');
    });
  });
}

/**
 * 智慧從雲端同步最新傳簽進度：保留當前使用者正在打字的欄位，載入其他主管最新送出的意見
 */
async function syncLatestReportFromCloud(isSilent = false) {
  const reportId = document.getElementById('serialNumber').value.trim();
  const gasUrl = getActiveGasUrl();
  if (!reportId || !gasUrl) return;

  const syncBtn = document.getElementById('btnSyncCloudProgress');
  if (syncBtn) {
    syncBtn.classList.add('rotating');
  }

  if (!isSilent) {
    showToast(`⏳ 正在同步單號 ${reportId} 雲端最新進度...`);
  }

  try {
    const res = await fetch(`${gasUrl}?action=getReport&id=${encodeURIComponent(reportId)}`);
    const json = await res.json();
    if (json && json.status === 'success' && json.record) {
      const current = collectFormData();
      const currentDirty = getDirtyFields(current);

      // 合併雲端最新資料與本地使用者目前正在輸入的欄位 (保護正在打字的欄位不被覆蓋)
      const mergedToDisplay = Object.assign({}, json.record);
      for (let i = 0; i < currentDirty.length; i++) {
        const k = currentDirty[i];
        mergedToDisplay[k] = current[k];
      }

      populateFormData(mergedToDisplay);

      // 更新未編輯欄位的基線快照
      if (baselineFormDataSnapshot) {
        for (const k in json.record) {
          if (currentDirty.indexOf(k) === -1) {
            baselineFormDataSnapshot[k] = json.record[k];
          }
        }
      }

      saveRecordToLocalHistory(json.record);
      syncPrintView();
      updateWorkflowProgressUI();

      if (!isSilent) {
        const summary = json.record.signProgress || computeLocalProgressSummary(json.record);
        showToast(`✅ 已同步最新傳簽進度！${summary}`);
      }
    } else if (!isSilent) {
      showToast('⚠️ 雲端尚無此單號或更新失敗');
    }
  } catch (err) {
    console.warn('Sync cloud progress error:', err);
    if (!isSilent) {
      showToast('⚠️ 同步雲端進度失敗：' + err.message);
    }
  } finally {
    if (syncBtn) {
      syncBtn.classList.remove('rotating');
    }
  }
}

/* ==========================================================================
   8. 工具列按鈕與 Modal 視窗控制
   ========================================================================== */
function bindToolbarAndModals() {
  document.getElementById('btnPrintTop').addEventListener('click', triggerPrintA4);
  document.getElementById('btnPrintBottom').addEventListener('click', triggerPrintA4);

  const btnSync = document.getElementById('btnSyncCloudProgress');
  if (btnSync) {
    btnSync.addEventListener('click', () => syncLatestReportFromCloud(false));
  }

  // 當使用者切換回此分頁時，自動於背景靜默檢查雲端是否有其他主管最新意見
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      const serial = document.getElementById('serialNumber').value.trim();
      if (serial) {
        syncLatestReportFromCloud(true);
      }
    }
  });

  document.getElementById('btnSaveDraftManual').addEventListener('click', () => {
    saveDraftToStorage(false);
  });

  document.getElementById('btnResetForm').addEventListener('click', () => {
    if (!confirm('確定要清空目前表單所有內容並建立新單號嗎？')) return;
    document.getElementById('incidentForm').reset();
    photoState.photo1 = '';
    photoState.photo2 = '';
    restorePhotoPreview(1, '');
    restorePhotoPreview(2, '');
    localStorage.removeItem(STORAGE_KEYS.DRAFT);
    window.history.replaceState({}, '', window.location.pathname);
    document.getElementById('serialNumber').value = generateSerialNumber(true);
    initDefaultDatesAndSerial();
    handleConditionalUI();
    syncPrintView();
    updateWorkflowProgressUI();
    updateShareLinkDisplay();
    document.getElementById('validationBanner').classList.remove('show');
    showToast('✨ 表單已清空並產生新單號');
  });

  document.getElementById('btnExportJson').addEventListener('click', () => {
    learnUserCustomEntries();
    const data = collectFormData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `管制藥品事故報告單_${data.serialNumber || '草稿'}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('⬇️ 已匯出 JSON 草稿備份檔');
  });

  const jsonInput = document.getElementById('jsonFileInput');
  document.getElementById('btnImportJson').addEventListener('click', () => jsonInput.click());
  jsonInput.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse(ev.target.result);
        populateFormData(parsed);
        saveDraftToStorage(true);
        showToast('⬆️ 成功匯入 JSON 表單資料！');
      } catch (err) {
        showToast('❌ JSON 檔案格式不正確');
      }
    };
    reader.readAsText(file);
    jsonInput.value = '';
  });

  document.getElementById('btnOpenHistory').addEventListener('click', () => {
    renderHistoryTable();
    openModal('historyModal');
  });

  document.getElementById('btnOpenCloudConfig').addEventListener('click', () => {
    document.getElementById('gasWebAppUrl').value = getActiveGasUrl();
    openModal('cloudConfigModal');
  });

  document.getElementById('btnSaveCloudConfig').addEventListener('click', () => {
    const url = document.getElementById('gasWebAppUrl').value.trim();
    localStorage.setItem(STORAGE_KEYS.GAS_URL, url);
    updateCloudStatusUI();
    updateShareLinkDisplay();
    closeModal('cloudConfigModal');
    showToast(url ? '☁️ 已儲存 Google 雲端傳簽網址！' : '已清除雲端設定');
  });

  document.getElementById('btnTestCloudConn').addEventListener('click', async () => {
    const url = document.getElementById('gasWebAppUrl').value.trim();
    if (!url) {
      showToast('⚠️ 請先貼上 Google Apps Script 網頁應用程式網址');
      return;
    }
    showToast('🔌 正在測試連線至 Google Apps Script...');
    try {
      const res = await fetch(`${url}?action=ping`);
      const json = await res.json();
      if (json && json.status === 'success') {
        showToast('✅ 連線成功！' + (json.message || 'Google 試算表後端運作正常'));
      } else {
        showToast('⚠️ 收到回應但狀態異常，請確認部署權限設為「所有人」');
      }
    } catch (err) {
      showToast('❌ 連線測試失敗：請確認網址為 /exec 結尾且部署權限為「所有人」');
    }
  });

  document.getElementById('btnFetchCloudRecords').addEventListener('click', async () => {
    const url = getActiveGasUrl();
    if (!url) {
      showToast('⚠️ 請先於「雲端設定」填寫 Google Apps Script 網址');
      return;
    }
    showToast('🔄 正在從 Google 試算表同步最新傳簽進度...');
    try {
      const res = await fetch(`${url}?action=listReports`);
      const json = await res.json();
      if (json && json.status === 'success' && Array.isArray(json.records)) {
        json.records.forEach((rec) => {
          saveRecordToLocalHistory(rec);
        });
        renderHistoryTable();
        showToast(`✅ 成功同步 ${json.records.length} 筆雲端傳簽紀錄`);
      } else {
        throw new Error('回傳格式不符');
      }
    } catch (err) {
      showToast('❌ 無法取得雲端紀錄：' + err.message);
    }
  });

  document.querySelectorAll('[data-close-modal]').forEach((btn) => {
    btn.addEventListener('click', () => {
      closeModal(btn.getAttribute('data-close-modal'));
    });
  });
}

function updateCloudStatusUI() {
  const url = getActiveGasUrl();
  const dot = document.getElementById('cloudStatusDot');
  const text = document.getElementById('cloudStatusText');
  if (!dot || !text) return;
  if (url) {
    dot.classList.remove('offline');
    text.textContent = 'Google 雲端傳簽已連線';
  } else {
    dot.classList.add('offline');
    text.textContent = '待設定雲端傳簽（點選右上角「雲端設定」）';
  }
}

function openModal(id) {
  document.getElementById(id).classList.add('open');
}

function closeModal(id) {
  document.getElementById(id).classList.remove('open');
}

function showToast(message) {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, 3800);
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
