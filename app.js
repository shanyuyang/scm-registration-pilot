(() => {
  'use strict';
  const api = document.body.dataset.apiPath;
  const $ = id => document.getElementById(id);
  const statuses = {EXTRACTED:'已提取',CONVERTED:'已换算',CROSS_CHECKED:'已交叉核验',DEFAULTED:'默认值',DERIVED_REVIEW:'待人工核对',MISSING:'资料缺失',CONFLICT:'来源冲突',MANUAL_CONFIRMED:'已应用',EDITED:'已修改',READY:'已就绪',REVIEW_REQUIRED:'待核对'};
  const warnings = {UNIT_UNKNOWN:'原始单位不明，请核对后输入标准单位数值',SOURCE_CONFLICT:'不同来源的数值存在差异',WEIGHT_SCOPE_DIFFERENCE:'商品重量与物流重量口径不同，请确认',READING_REVIEW_REQUIRED:'已根据商品名自动生成读音，可核对或修改',CROSS_CHECK_UNAVAILABLE:'缺少可验证的交叉来源',INVALID_NUMBER:'原始数字格式异常'};
  warnings.NAME_CHANGED_READING_REVIEW = '商品名称已修改，请重新核对两个读音字段';
  warnings.PRICE_COMPONENT_MISSING = '请核对原単価、マージン和パッケージ，并填写合计';
  warnings.ALPHANUMERIC_READING_REVIEW = '英数字已自动转换为字母名和日文数字读音';
  warnings.READING_UNRESOLVED = '商品名中仍有无法转换的内容，请填写半角カナ';
  warnings.NON_ASCII_ENGLISH = '此字段需半角英文，仍有中文或日文时请人工修改';
  const readyStatuses = new Set(['EXTRACTED','CONVERTED','CROSS_CHECKED','DEFAULTED','MANUAL_CONFIRMED']);
  let accessCode = '';
  let settings, batch, activeJan, filter = 'all', selectedFiles = [], working = false;

  function element(tag, className, text) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined) item.textContent = text;
    return item;
  }
  function message(text, error = false) {
    const box = $('message');
    box.hidden = !text;
    box.className = 'message' + (error ? ' error' : '');
    box.textContent = text || '';
  }
  async function request(path, options) {
    const headers = new Headers(options?.headers);
    headers.set('X-Pilot-Access', accessCode);
    const response = await fetch(api + path, {cache:'no-store',...options,headers});
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      const detail = data?.detail;
      const info = typeof detail === 'string' ? detail : detail?.message || (Array.isArray(detail) ? '输入格式有误，请检查后重试' : '请求失败，请稍后重试');
      const issues = detail?.errors?.map(item => item.message).filter(Boolean).join('；');
      const error = new Error(issues ? info + ' · ' + issues : info);
      error.status = response.status;
      throw error;
    }
    return response;
  }
  function permitted(name) { return Boolean(settings?.permissions?.includes(name)); }
  function record() { return batch?.records.find(r => r.jan === activeJan); }
  function displayValue(item) {
    const key = item.field_key;
    return key === '仕入先' || key.includes('材質') ? item.csv_value : item.value;
  }
  function editable(key) { return !['商品コード','仕入先'].includes(key) && permitted('business.edit'); }
  function busy(value) {
    working = value;
    document.body.classList.toggle('busy', value);
    $('preview').disabled = value || !permitted('file.import') || !selectedFiles.length;
    $('preview').textContent = value ? '正在处理…' : '生成预览';
    $('export').disabled = value || !batch || !permitted('file.export');
    $('files').disabled = value || !permitted('file.import');
    $('record').disabled = value;
    $('normalize-names').disabled = value || !batch || !editable('商品名称');
    for (const item of $('fields').querySelectorAll('input,textarea,select')) item.disabled = value || !editable(item.dataset.key);
  }
  async function action(task) {
    if (working) return;
    busy(true);
    try { await task(); } catch (error) { message(error.message, true); }
    finally { busy(false); }
  }
  function setFiles(files) {
    const combined = [...selectedFiles, ...files];
    selectedFiles = combined.filter((file, i) => combined.findIndex(other => other.name === file.name && other.size === file.size && other.lastModified === file.lastModified) === i);
    $('selected-files').replaceChildren();
    selectedFiles.forEach((file, index) => {
      const chip = element('span', 'file-chip', file.name + ' · ' + (file.size / 1024).toFixed(0) + ' KB');
      const remove = element('button', '', '×');
      remove.type = 'button'; remove.setAttribute('aria-label', '移除 ' + file.name);
      remove.onclick = () => { selectedFiles.splice(index, 1); setFiles([]); };
      chip.append(remove); $('selected-files').append(chip);
    });
    busy(working);
  }
  function badge(status) {
    return element('span','status' + (readyStatuses.has(status) || status === 'READY' ? ' good' : status === 'CONFLICT' ? ' conflict' : ''),statuses[status] || status);
  }
  function setFilter(next) {
    filter = next;
    document.querySelectorAll('[data-filter]').forEach(button => button.classList.toggle('selected',button.dataset.filter === filter));
  }
  function matches(item, editedValue) {
    return filter === 'all' || (filter === 'pending' && (editedValue !== undefined || !readyStatuses.has(item.status))) ||
      (filter === 'conflict' && item.status === 'CONFLICT') || (filter === 'missing' && !(editedValue ?? displayValue(item)));
  }
  function renderFields() {
    const current = record();
    const edits = current.edits ??= {};
    $('fields').replaceChildren();
    for (const key of settings.columns) {
      const item = current.fields[key];
      if (!matches(item, edits[key])) continue;
      const row = element('tr');
      if (key.startsWith('インナーサイズ')) row.classList.add('inner-size');
      if (key.startsWith('カートンサイズ')) row.classList.add('carton-size');
      const name = element('td','field-name');
      const savedBadge = badge(item.status);
      const editedBadge = badge('EDITED');
      function showEditStatus() {
        savedBadge.hidden = Object.hasOwn(edits,key);
        editedBadge.hidden = !savedBadge.hidden;
      }
      name.append(element('strong','',key + (item.required ? ' *' : '')),savedBadge,editedBadge);
      const valueCell = element('td','value-cell');
      const raw = displayValue(item);
      let input;
      const options = key === '工場' ? current.factory_options : settings.dropdowns[key];
      if (options) {
        input = element('select');
        input.append(new Option(key === '工場' ? '请选择工厂' : '（留空）',''));
        for (const [code, label] of Object.entries(options)) input.append(new Option(code + ' · ' + label,code));
        if (item.value && !Object.hasOwn(options,item.value)) input.append(new Option(item.value,item.value));
      } else if (key === '詳細コメント１' || key === 'アソート情報' || /[\r\n]/.test(raw)) {
        input = element('textarea'); input.rows = /[\r\n]/.test(edits[key] ?? raw) ? 2 : 1;
      } else { input = element('input'); input.type = key === '販売開始予定日' ? 'date' : 'text'; }
      if (key !== '仕入先') input.classList.add('field-value');
      input.dataset.key = key;
      input.value = raw;
      if (input.type === 'date' && raw && !input.value) {
        input.type = 'text';
        input.value = raw;
      }
      // Compare against the rendered baseline, including browser newline normalization.
      const initialValue = input.value;
      input.value = edits[key] ?? initialValue;
      showEditStatus();
      input.disabled = !editable(key); input.setAttribute('aria-label',key + ' 拟填值');
      if (item.target_unit) input.setAttribute('title','标准单位：' + item.target_unit + '；只填写数字');
      valueCell.append(input);
      if (key.includes('材質')) input.title = '每栏填写一个材质名称或 MAT_CD';
      const sourceCell = element('td','source-cell');
      const first = item.sources[0];
      const label = element('strong','review-label',options?.[input.value] || item.review_value || first?.raw_value || '—');
      sourceCell.append(label);
      const details = element('details'); details.append(element('summary','','查看来源'));
      for (const source of item.sources) {
        const evidence = element('div','source-evidence');
        evidence.append(element('div','',source.file_name + ' · ' + source.sheet + '!' + source.cell),element('div','','原值：' + (source.raw_value || '（空）') + ' · 单位：' + (source.raw_unit || '未标注')),element('div','',source.formula || 'identity'),element('code','','SHA-256 ' + source.sha256));
        if (source.source_formula) evidence.append(element('div','','原公式：' + source.source_formula));
        for (const unit of source.unit_sources || []) evidence.append(element('div','','单位证据：' + unit.sheet + '!' + unit.cell + ' = ' + unit.raw_value));
        details.append(evidence);
      }
      if (first) sourceCell.append(details);
      if (item.status !== 'MANUAL_CONFIRMED') for (const warning of item.warnings) sourceCell.append(element('div','value-note',warnings[warning] || warning));
      input.oninput = () => {
        if (!editable(key)) return;
        if (input.value === initialValue) delete edits[key];
        else edits[key] = input.value;
        showEditStatus();
      };
      input.onchange = () => {
        if (options) label.textContent = options[input.value] || '—';
        input.oninput();
      };
      row.append(name,valueCell,sourceCell); $('fields').append(row);
    }
    if (!$('fields').children.length) { const row = element('tr'); const cell = element('td','placeholder','没有符合此筛选的字段'); cell.colSpan = 3; row.append(cell); $('fields').append(row); }
  }
  function render() {
    $('empty').hidden = Boolean(batch); $('review').hidden = !batch;
    if (!batch) return;
    const current = record();
    $('batch-number').textContent = batch.records.length + ' 个商品';
    $('product-title').textContent = current.fields['商品名称'].value || '待补充商品名称';
    batch.status = batch.records.every(r => r.ready) ? 'READY' : 'REVIEW_REQUIRED';
    const status = badge(batch.status); $('batch-status').className = status.className; $('batch-status').textContent = status.textContent;
    $('record').replaceChildren(...batch.records.map(r => new Option(r.jan + (r.ready ? ' · 已就绪' : ' · 待核对'),r.jan)));
    $('record').value = activeJan;
    $('ready-count').textContent = Object.values(current.fields).filter(f => readyStatuses.has(f.status)).length;
    $('pending-count').textContent = current.pending_fields.length;
    $('conflict-count').textContent = Object.values(current.fields).filter(f => f.status === 'CONFLICT').length;
    $('source-files').replaceChildren();
    for (const file of batch.files.filter(f => f.jan === activeJan)) {
      const box = element('div','source-file');
      box.append(element('strong','','检品报告 · ' + file.file_name),element('div','',file.template_version),element('code','','SHA-256 ' + file.sha256)); $('source-files').append(box);
    }
    $('record-errors').hidden = !current.errors.length; $('record-errors').textContent = current.errors.map(e => e.message).join('；');
    renderFields(); busy(working);
  }
  function workingCopy(item) {
    return {supplier_code:item.supplier_code,fields:Object.fromEntries(Object.entries(item.fields).map(([key,field]) => [key,{value:field.value,status:field.status,manual_confirmed:field.history.some(h => h.action === 'MANUAL_CONFIRMED')}]))};
  }
  function updateRecord(updated, current = record()) {
    for (const [key,item] of Object.entries(updated.fields)) {
      const original = current.fields[key];
      const sources = original.sources;
      const regenerated = item.history.some(h => ['DERIVED_CANDIDATE','NAME_CHANGED_REVIEW_REQUIRED'].includes(h.action));
      const previousWarnings = regenerated ? original.warnings.filter(w => !['READING_REVIEW_REQUIRED','ALPHANUMERIC_READING_REVIEW','READING_UNRESOLVED','NAME_CHANGED_READING_REVIEW'].includes(w)) : original.warnings;
      const warnings = [...new Set([...previousWarnings,...item.warnings])];
      Object.assign(original,item,{sources,warnings});
    }
    for (const key of ['ready','status','errors','pending_fields','factory_options']) current[key] = updated[key];
  }
  async function applyEdits(current) {
    const changes = current.edits;
    if (!changes || !Object.keys(changes).length) return;
    try {
      const updated = await (await request('/records/confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...workingCopy(current),changes})})).json();
      updateRecord(updated,current);
      current.edits = {};
    } catch (error) {
      activeJan = current.jan;
      setFilter('all');
      throw new Error(current.jan + ' · ' + error.message);
    }
  }
  async function download() {
    try {
      for (const current of batch.records) await applyEdits(current);
    } finally {
      render();
    }
    const response = await request('/export.csv',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({records:batch.records.map(workingCopy)})});
    const url = URL.createObjectURL(await response.blob());
    const link = element('a'); link.href = url; link.download = 'registration_' + (batch.records.length === 1 ? activeJan : 'multiple') + '.csv';
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url),1000);
    message('登录资料 CSV 已下载。');
  }
  $('files').onchange = event => { setFiles([...event.target.files]); event.target.value = ''; };
  const zone = $('dropzone');
  zone.onkeydown = event => { if (['Enter',' '].includes(event.key)) { event.preventDefault(); $('files').click(); } };
  zone.ondragover = event => { event.preventDefault(); zone.classList.add('dragging'); };
  zone.ondragleave = () => zone.classList.remove('dragging');
  zone.ondrop = event => { event.preventDefault(); zone.classList.remove('dragging'); if (!working && permitted('file.import')) setFiles([...event.dataTransfer.files]); };
  $('preview').onclick = () => action(async () => {
    const mb = 1024 * 1024;
    if (selectedFiles.length > settings.max_files || selectedFiles.some(file =>
      !file.name.toLowerCase().endsWith('.xlsx') || file.size > settings.max_file_mb * mb
    ) || selectedFiles.reduce((size, file) => size + file.size, 0) > settings.max_total_mb * mb) {
      throw new Error('请上传最多 20 份 .xlsx，单份最多 5 MB，合计最多 60 MB。');
    }
    const groups = [];
    let group = [];
    let size = 0;
    for (const file of selectedFiles) {
      if (size + file.size > settings.max_request_mb * mb && group.length) {
        groups.push(group);
        group = [];
        size = 0;
      }
      group.push(file);
      size += file.size;
    }
    if (group.length) groups.push(group);
    const previews = [];
    const records = [];
    const jans = new Set();
    for (const files of groups) {
      const data = new FormData();
      files.forEach(file => data.append('files', file));
      const preview = await (await request('/imports/preview', {method:'POST', body:data})).json();
      previews.push(...preview.files);
      for (const item of preview.records) {
        if (jans.has(item.jan)) throw new Error('同一批有重复的 JAN ' + item.jan + '，请分开上传。');
        jans.add(item.jan);
        records.push(item);
      }
    }
    batch = {files: previews, records};
    activeJan = records[0].jan;
    setFilter('all');
    selectedFiles = []; setFiles([]);
    render(); message('');
  });
  $('record').onchange = () => { activeJan = $('record').value; render(); };
  document.querySelectorAll('[data-filter]').forEach(button => button.onclick = () => { if (working) return; setFilter(button.dataset.filter); renderFields(); });
  $('normalize-names').onclick = () => action(async () => {
    const current = record();
    try {
      await applyEdits(current);
      const updated = await (await request('/records/normalize-names',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(workingCopy(current))})).json();
      updateRecord(updated,current);
    } finally {
      render();
    }
    message('已根据商品名自动生成读音并统一英文半角，可核对或修改。');
  });
  $('export').onclick = () => action(download);
  async function enter(code) {
    if (!api) throw new Error('云端接口尚未配置。');
    accessCode = code.trim();
    try { settings = await (await request('/settings')).json(); }
    catch (error) { accessCode = ''; throw error; }
    $('pilot-code').value = '';
    $('pilot-login').hidden = true;
    $('pilot-upload').hidden = false;
    $('pilot-workspace').hidden = false;
    message('');
  }
  $('pilot-login').onsubmit = event => {
    event.preventDefault();
    action(() => enter($('pilot-code').value));
  };
  busy(false);
  if (document.body.dataset.linkMode === 'true') {
    const access = new URLSearchParams(location.hash.slice(1)).get('access');
    if (access) {
      message('正在连接试用服务…');
      action(() => enter(access));
    } else {
      message('请用收到的完整试用链接打开此页。', true);
    }
  }
})();
