pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

/* ---------------- Storage helpers ---------------- */
const LS_BOOKS = 'kitaplik_books';
const LS_STATS = 'kitaplik_stats';
let db;

function openDB(){
  return new Promise((res,rej)=>{
    const req = indexedDB.open('kitaplikDB', 1);
    req.onupgradeneeded = e=>{
      const d = e.target.result;
      if(!d.objectStoreNames.contains('pdfs')) d.createObjectStore('pdfs');
      if(!d.objectStoreNames.contains('texts')) d.createObjectStore('texts');
    };
    req.onsuccess = e=>{ db=e.target.result; res(db); };
    req.onerror = e=> rej(e);
  });
}
function idbSet(store,key,val){
  return new Promise((res,rej)=>{
    const tx = db.transaction(store,'readwrite');
    tx.objectStore(store).put(val,key);
    tx.oncomplete=()=>res();
    tx.onerror=e=>rej(e);
  });
}
function idbGet(store,key){
  return new Promise((res,rej)=>{
    const tx = db.transaction(store,'readonly');
    const r = tx.objectStore(store).get(key);
    r.onsuccess=()=>res(r.result);
    r.onerror=e=>rej(e);
  });
}
function idbDelete(store,key){
  return new Promise((res,rej)=>{
    const tx = db.transaction(store,'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete=()=>res();
    tx.onerror=e=>rej(e);
  });
}

function getBooks(){ return JSON.parse(localStorage.getItem(LS_BOOKS) || '[]'); }
function saveBooks(b){ localStorage.setItem(LS_BOOKS, JSON.stringify(b)); }
function getStats(){
  return JSON.parse(localStorage.getItem(LS_STATS) || JSON.stringify({
    streak:0, lastReadDate:null, totalPagesRead:0, todayPagesRead:0, todayDate:null,
    dailyGoal:10, badges:[]
  }));
}
function saveStats(s){ localStorage.setItem(LS_STATS, JSON.stringify(s)); }

/* ---------------- Motivational quotes ---------------- */
const QUOTES = [
  "Bir kitap açmak, kapalı bir kapıyı aralamaktır.",
  "Bugün okuduğun her sayfa, yarının sana bıraktığı bir mirastır.",
  "Okuyan insan hiçbir zaman yalnız değildir.",
  "Bir sayfa bile olsa, devam et — kaldığın yeri biz hatırlıyoruz.",
  "En uzun yolculuklar bile tek bir sayfayla başlar.",
  "Kitap bitmez, sadece bir sonrakine bırakılır.",
  "Gün ne kadar yorucu olursa olsun, birkaç satır senin.",
];
function showQuote(){
  document.getElementById('quoteStrip').textContent = '“'+QUOTES[Math.floor(Math.random()*QUOTES.length)]+'”';
}

/* ---------------- App state ---------------- */
let currentFilter = 'all';
let currentTab = 'pdf';
let activeBook = null;
let pdfDoc = null;
let currentPdfPage = 1;
let pdfRotation = 0;
let textPages = [];
let currentTextPageIdx = 0;
let fontSize = 17;
let sessionStartPage = 0;

/* ---------------- Init ---------------- */
window.addEventListener('DOMContentLoaded', async ()=>{
  await openDB();
  showQuote();
  refreshStreakDisplay();
  renderLibrary();
  setupDropzone();
});

/* ---------------- Streak / stats ---------------- */
function todayStr(){ return new Date().toISOString().slice(0,10); }
function refreshStreakDisplay(){
  const s = getStats();
  if(s.todayDate !== todayStr()) { s.todayPagesRead = 0; s.todayDate = todayStr(); saveStats(s); }
  document.getElementById('streakCount').textContent = s.streak;
}
function registerReadingActivity(pagesDelta){
  const s = getStats();
  const today = todayStr();
  if(s.todayDate !== today){ s.todayPagesRead = 0; s.todayDate = today; }
  s.todayPagesRead += pagesDelta;
  s.totalPagesRead += pagesDelta;

  if(s.lastReadDate !== today){
    const y = new Date(); y.setDate(y.getDate()-1);
    const yStr = y.toISOString().slice(0,10);
    s.streak = (s.lastReadDate === yStr) ? s.streak + 1 : 1;
    s.lastReadDate = today;
  }
  saveStats(s);
  refreshStreakDisplay();
  checkBadges(s);
}
const BADGE_DEFS = [
  {id:'ilk-adim', icon:'📚', label:'İlk kitap eklendi', test:s=>getBooks().length>=1},
  {id:'ilk-sayfa', icon:'📖', label:'İlk sayfa okundu', test:s=>s.totalPagesRead>=1},
  {id:'seri-3', icon:'🔥', label:'3 günlük seri', test:s=>s.streak>=3},
  {id:'seri-7', icon:'⭐', label:'7 günlük seri', test:s=>s.streak>=7},
  {id:'yuz-sayfa', icon:'💯', label:'100 sayfa okundu', test:s=>s.totalPagesRead>=100},
  {id:'ilk-bitirme', icon:'🏆', label:'İlk kitap bitti', test:s=>getBooks().some(b=>b.status==='finished')},
];
function checkBadges(s){
  let changed=false;
  BADGE_DEFS.forEach(b=>{
    if(!s.badges.includes(b.id) && b.test(s)){
      s.badges.push(b.id); changed=true;
      showToast('🎉 Yeni rozet: '+b.label);
    }
  });
  if(changed) saveStats(s);
}

/* ---------------- Library rendering ---------------- */
function setFilter(f){
  currentFilter = f;
  document.querySelectorAll('.filter-btn').forEach(b=>b.classList.toggle('active', b.dataset.f===f));
  renderLibrary();
}
function renderLibrary(){
  const books = getBooks();
  let list = books;
  if(currentFilter==='reading') list = books.filter(b=>b.status!=='finished');
  if(currentFilter==='finished') list = books.filter(b=>b.status==='finished');

  const grid = document.getElementById('grid');
  const empty = document.getElementById('emptyState');
  grid.innerHTML='';
  if(list.length===0){ empty.style.display='block'; grid.style.display='none'; return; }
  empty.style.display='none'; grid.style.display='grid';

  list.sort((a,b)=> (b.lastReadDate||b.addedDate).localeCompare(a.lastReadDate||a.addedDate));

  list.forEach(b=>{
    const progress = b.type==='pdf'
      ? Math.round(((b.currentPage||1)/(b.totalPages||1))*100)
      : Math.round((b.scrollRatio||0)*100);
    const finished = b.status==='finished';
    const card = document.createElement('div');
    card.className='book-card';
    card.innerHTML = `
      <div class="ribbon ${finished?'finished':''}"></div>
      <div class="book-type">${b.type==='pdf'?'PDF':'Metin'}</div>
      <div class="book-title">${escapeHtml(b.title)}</div>
      <div class="book-author">${escapeHtml(b.author||'')}</div>
      <div class="book-progress-bar"><div class="book-progress-fill ${finished?'finished':''}" style="width:${progress}%"></div></div>
      <div class="book-meta"><span>${finished?'Tamamlandı':progress+'% okundu'}</span><span>${b.type==='pdf'?(b.totalPages+' sayfa'):''}</span></div>
      <div class="book-actions">
        <button class="btn-continue" onclick="openReader('${b.id}')">${finished?'Tekrar Oku':'Devam Et'}</button>
        <button class="btn-delete" onclick="deleteBook('${b.id}')">Sil</button>
      </div>
    `;
    grid.appendChild(card);
  });
}
function escapeHtml(s){ const d=document.createElement('div'); d.textContent=s||''; return d.innerHTML; }

/* ---------------- Add modal ---------------- */
function openAddModal(){
  document.getElementById('addOverlay').classList.add('show');
  document.getElementById('inpTitle').value='';
  document.getElementById('inpAuthor').value='';
  document.getElementById('inpText').value='';
  document.getElementById('fileInput').value='';
  document.getElementById('dropzoneText').textContent='Tıkla ya da PDF dosyasını buraya sürükle';
  switchTab('pdf');
}
function closeAddModal(){ document.getElementById('addOverlay').classList.remove('show'); }
function switchTab(t){
  currentTab=t;
  document.getElementById('tabPdfBtn').classList.toggle('active', t==='pdf');
  document.getElementById('tabTextBtn').classList.toggle('active', t==='text');
  document.getElementById('pdfTab').style.display = t==='pdf'?'block':'none';
  document.getElementById('textTab').style.display = t==='text'?'block':'none';
}
function setupDropzone(){
  const dz = document.getElementById('dropzone');
  const fi = document.getElementById('fileInput');
  dz.addEventListener('dragover', e=>{e.preventDefault(); dz.classList.add('drag');});
  dz.addEventListener('dragleave', ()=> dz.classList.remove('drag'));
  dz.addEventListener('drop', e=>{
    e.preventDefault(); dz.classList.remove('drag');
    if(e.dataTransfer.files[0]){ fi.files = e.dataTransfer.files; updateDropzoneLabel(); }
  });
  fi.addEventListener('change', updateDropzoneLabel);
}
function updateDropzoneLabel(){
  const fi = document.getElementById('fileInput');
  if(fi.files[0]) document.getElementById('dropzoneText').textContent = '📄 '+fi.files[0].name;
}

async function addBook(){
  const title = document.getElementById('inpTitle').value.trim();
  if(!title){ showToast('Lütfen kitap adı gir'); return; }
  const author = document.getElementById('inpAuthor').value.trim();
  const id = 'b_'+Date.now()+'_'+Math.random().toString(36).slice(2,7);

  if(currentTab==='pdf'){
    const file = document.getElementById('fileInput').files[0];
    if(!file){ showToast('Lütfen bir PDF seç'); return; }
    const bytes = await file.arrayBuffer();
    await idbSet('pdfs', id, bytes.slice(0));
    let totalPages = 1;
    try{
      const doc = await pdfjsLib.getDocument({data: bytes.slice(0)}).promise;
      totalPages = doc.numPages;
    }catch(e){ showToast('PDF okunamadı, yine de eklendi'); }

    const books = getBooks();
    books.push({id, title, author, type:'pdf', totalPages, currentPage:1, status:'reading',
      addedDate:todayStr(), lastReadDate:null});
    saveBooks(books);
  } else {
    const text = document.getElementById('inpText').value;
    if(!text.trim()){ showToast('Lütfen metni yapıştır'); return; }
    await idbSet('texts', id, text);
    const books = getBooks();
    books.push({id, title, author, type:'text', charCount:text.length, scrollRatio:0, status:'reading',
      addedDate:todayStr(), lastReadDate:null});
    saveBooks(books);
  }

  closeAddModal();
  renderLibrary();
  showQuote();
  const s = getStats(); checkBadges(s);
  showToast('“'+title+'” rafa eklendi 📚');
}

async function deleteBook(id){
  if(!confirm('Bu kitabı ve okuma ilerlemeni silmek istediğine emin misin?')) return;
  const books = getBooks().filter(b=>b.id!==id);
  saveBooks(books);
  await idbDelete('pdfs', id);
  await idbDelete('texts', id);
  renderLibrary();
  showToast('Kitap silindi');
}

/* ---------------- Reader: open/close ---------------- */
async function openReader(id){
  const books = getBooks();
  activeBook = books.find(b=>b.id===id);
  if(!activeBook) return;
  sessionStartPage = activeBook.type==='pdf' ? (activeBook.currentPage||1) : Math.round((activeBook.scrollRatio||0)*estimatePages(activeBook));

  document.getElementById('readerTitle').textContent = activeBook.title;
  document.getElementById('reader').classList.add('show');

  if(activeBook.type==='pdf'){
    document.getElementById('pdfCanvas').style.display='block';
    document.getElementById('textPage').style.display='none';
    document.getElementById('pdfFooter').style.display='flex';
    document.getElementById('fontBtns').style.display='none';
    document.getElementById('rotateBtn').style.display='inline-block';
    pdfRotation = 0;
    const bytes = await idbGet('pdfs', id);
    pdfDoc = await pdfjsLib.getDocument({data: bytes.slice(0)}).promise;
    currentPdfPage = activeBook.currentPage || 1;
    renderPdfPage(currentPdfPage);
    window.addEventListener('resize', onReaderResize);
  } else {
    document.getElementById('pdfCanvas').style.display='none';
    document.getElementById('textPage').style.display='block';
    document.getElementById('pdfFooter').style.display='none';
    document.getElementById('fontBtns').style.display='flex';
    document.getElementById('rotateBtn').style.display='none';
    const text = await idbGet('texts', id);
    document.getElementById('textPage').style.fontSize = fontSize+'px';
    document.getElementById('textPage').textContent = text;
    const body = document.getElementById('readerBody');
    setTimeout(()=>{
      body.scrollTop = (activeBook.scrollRatio||0) * (body.scrollHeight - body.clientHeight);
    }, 30);
    body.onscroll = onTextScroll;
    updateTextProgressDisplay();
  }
}
function closeReader(){
  document.getElementById('reader').classList.remove('show');
  const body = document.getElementById('readerBody');
  body.onscroll = null;
  window.removeEventListener('resize', onReaderResize);
  if(activeBook && activeBook.type!=='pdf'){
    saveTextProgress(true);
  }
  finalizeSession();
  pdfDoc = null; activeBook = null;
  renderLibrary();
}
function onReaderResize(){
  if(pdfDoc && currentPdfPage) renderPdfPage(currentPdfPage);
}
function rotatePage(){
  pdfRotation = (pdfRotation + 90) % 360;
  if(pdfDoc) renderPdfPage(currentPdfPage);
}
function finalizeSession(){
  if(!activeBook) return;
  const endPage = activeBook.type==='pdf' ? (activeBook.currentPage||1) : Math.round((activeBook.scrollRatio||0)*estimatePages(activeBook));
  const delta = Math.max(0, endPage - sessionStartPage);
  if(delta>0) registerReadingActivity(delta);
  if(delta>0) showToast('Bu oturumda yaklaşık '+delta+' sayfa okudun 👏');
}
function estimatePages(book){
  if(book.type==='pdf') return book.totalPages||1;
  return Math.max(1, Math.round((book.charCount||0)/1800));
}

/* ---------------- PDF navigation ---------------- */
async function renderPdfPage(num){
  const page = await pdfDoc.getPage(num);
  const canvas = document.getElementById('pdfCanvas');
  const ctx = canvas.getContext('2d');

  // Ekran yatay ya da dikey olsun, sayfayı mevcut alana sığdır (döndürme dahil)
  const body = document.getElementById('readerBody');
  const availW = Math.max(200, body.clientWidth - 24);
  const availH = Math.max(200, body.clientHeight - 24);
  const baseViewport = page.getViewport({scale: 1, rotation: pdfRotation});
  const scale = Math.min(availW / baseViewport.width, availH / baseViewport.height, 3);
  const viewport = page.getViewport({scale: Math.max(scale, 0.3), rotation: pdfRotation});

  canvas.width = viewport.width; canvas.height = viewport.height;
  await page.render({canvasContext: ctx, viewport}).promise;
  document.getElementById('pageIndicator').textContent = num+' / '+pdfDoc.numPages;
  document.getElementById('readerProgressFill').style.width = Math.round((num/pdfDoc.numPages)*100)+'%';
  persistPdfProgress(num);
}
function persistPdfProgress(num){
  const books = getBooks();
  const b = books.find(x=>x.id===activeBook.id);
  b.currentPage = num;
  b.lastReadDate = todayStr();
  if(num >= b.totalPages) b.status='finished';
  saveBooks(books);
  activeBook = b;
  if(num >= b.totalPages) celebrateFinish();
}
function nextPage(){ if(currentPdfPage < pdfDoc.numPages){ currentPdfPage++; renderPdfPage(currentPdfPage);} }
function prevPage(){ if(currentPdfPage > 1){ currentPdfPage--; renderPdfPage(currentPdfPage);} }

/* ---------------- Text reading ---------------- */
function onTextScroll(){
  saveTextProgress(false);
}
function saveTextProgress(force){
  const body = document.getElementById('readerBody');
  const max = body.scrollHeight - body.clientHeight;
  const ratio = max>0 ? Math.min(1, body.scrollTop/max) : 1;
  const books = getBooks();
  const b = books.find(x=>x.id===activeBook.id);
  b.scrollRatio = ratio;
  b.lastReadDate = todayStr();
  if(ratio >= 0.98) b.status='finished';
  saveBooks(books);
  activeBook = b;
  document.getElementById('readerProgressFill').style.width = Math.round(ratio*100)+'%';
  if(ratio>=0.98 && force!==false) celebrateFinish();
}
function updateTextProgressDisplay(){
  document.getElementById('readerProgressFill').style.width = Math.round((activeBook.scrollRatio||0)*100)+'%';
}
function changeFont(delta){
  fontSize = Math.max(13, Math.min(26, fontSize+delta*1));
  document.getElementById('textPage').style.fontSize = fontSize+'px';
}
function toggleNight(){
  document.getElementById('reader').classList.toggle('night');
}
function celebrateFinish(){
  showToast('🎉 Kitabı bitirdin! Harikasın.');
}

/* ---------------- Stats modal ---------------- */
function openStats(){
  const s = getStats();
  document.getElementById('statStreak').textContent = s.streak+' gün';
  document.getElementById('statToday').textContent = s.todayPagesRead+' sayfa';
  document.getElementById('statTotal').textContent = s.totalPagesRead+' sayfa';
  document.getElementById('statFinished').textContent = getBooks().filter(b=>b.status==='finished').length;
  document.getElementById('inpGoal').value = s.dailyGoal;
  const grid = document.getElementById('badgeGrid');
  grid.innerHTML='';
  BADGE_DEFS.forEach(b=>{
    const unlocked = s.badges.includes(b.id);
    const el = document.createElement('div');
    el.className = 'badge'+(unlocked?' unlocked':'');
    el.innerHTML = `<span class="icon">${b.icon}</span>${b.label}`;
    grid.appendChild(el);
  });
  document.getElementById('statsOverlay').classList.add('show');
}
function closeStats(){ document.getElementById('statsOverlay').classList.remove('show'); }
function saveGoal(){
  const s = getStats();
  const v = parseInt(document.getElementById('inpGoal').value)||10;
  s.dailyGoal = v;
  saveStats(s);
  showToast('Günlük hedef kaydedildi: '+v+' sayfa');
}

/* ---------------- Toast ---------------- */
let toastTimer;
function showToast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=> t.classList.remove('show'), 3200);
}