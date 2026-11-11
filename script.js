pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

/* ---------------- Storage helpers ---------------- */
const LS_BOOKS = 'kitaplik_books';
const LS_STATS = 'kitaplik_stats';
const LS_READING_BOOKMARK = 'kitaplik_reading_bookmark';
let db;
let readerZoom = 100;

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
function saveBooks(b){ localStorage.setItem(LS_BOOKS, JSON.stringify(b)); if(window.queueCloudSync) window.queueCloudSync(); }
function getStats(){
  return JSON.parse(localStorage.getItem(LS_STATS) || JSON.stringify({
    streak:0, lastReadDate:null, totalPagesRead:0, todayPagesRead:0, todayDate:null,
    dailyGoal:10, badges:[]
  }));
}
function saveStats(s){ s.updatedAt=Date.now(); localStorage.setItem(LS_STATS, JSON.stringify(s)); if(window.queueCloudSync) window.queueCloudSync(); }


/* ---------------- Persistent reading bookmark ---------------- */
function getReadingBookmark(){
  try { return JSON.parse(localStorage.getItem(LS_READING_BOOKMARK) || 'null'); }
  catch(e){ return null; }
}
function saveReadingBookmark(){
  const title=document.getElementById('bookmarkBookTitle').value.trim();
  const rawPage=document.getElementById('bookmarkPage').value.trim();
  const page=Number(rawPage);
  if(!title || !rawPage || !Number.isInteger(page) || page<1){ showToast('Kitap adını ve geçerli sayfa numarasını gir'); return; }
  const record={title,page,updatedAt:new Date().toISOString()};
  localStorage.setItem(LS_READING_BOOKMARK,JSON.stringify(record));
  if(window.queueCloudSync) window.queueCloudSync();
  renderReadingBookmark();
  showToast('Okuma konumun kaydedildi');
}
function renderReadingBookmark(){
  const record=getReadingBookmark();
  const titleInput=document.getElementById('bookmarkBookTitle');
  const pageInput=document.getElementById('bookmarkPage');
  const display=document.getElementById('bookmarkSaved');
  if(!titleInput || !pageInput || !display) return;
  if(record){
    titleInput.value=record.title;
    pageInput.value=record.page;
    const date=record.updatedAt ? new Date(record.updatedAt).toLocaleString('tr-TR') : '';
    display.innerHTML='<strong>'+escapeHtml(record.title)+'</strong><span>Sayfa '+record.page+'</span><small>Son kayıt: '+escapeHtml(date)+'</small>';
  } else {
    display.textContent='Henüz kayıtlı bir okuma konumu yok.';
  }
}
function syncReadingBookmark(book,page){
  if(!book) return;
  const record={title:book.title,page:Math.max(1,page||1),bookId:book.id,updatedAt:new Date().toISOString()};
  localStorage.setItem(LS_READING_BOOKMARK,JSON.stringify(record));
  if(window.queueCloudSync) window.queueCloudSync();
  renderReadingBookmark();
}

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
let timerTick = null;
let timerBookId = null;
const LS_READING_TIMERS = 'kitaplik_reading_timers';
function getReadingTimers(){ return JSON.parse(localStorage.getItem(LS_READING_TIMERS) || '{}'); }
function saveReadingTimers(data){ data.updatedAt=Date.now(); localStorage.setItem(LS_READING_TIMERS, JSON.stringify(data)); if(window.queueCloudSync) window.queueCloudSync(); }
function timerElapsed(t){
  if(!t) return 0;
  return Math.max(0, (t.elapsedMs||0) + (t.startedAt ? Date.now()-t.startedAt : 0));
}
function formatReadingTime(ms){
  const sec=Math.floor(ms/1000), h=Math.floor(sec/3600), m=Math.floor((sec%3600)/60), s=sec%60;
  return [h,m,s].map(v=>String(v).padStart(2,'0')).join(':');
}
function currentReadingTimer(){
  if(!activeBook) return null;
  const all=getReadingTimers();
  return all[activeBook.id] || {elapsedMs:0,startedAt:null,sessions:[]};
}
function renderReadingTimer(){
  if(!activeBook) return;
  const t=currentReadingTimer(), running=!!t.startedAt;
  document.getElementById('readingTimerDisplay').textContent=formatReadingTime(timerElapsed(t));
  document.getElementById('bookTotalReadingTime').textContent=formatReadingTime((t.totalMs||0)+timerElapsed(t));
  document.getElementById('readingTimerStatus').textContent=running?'Okuma devam ediyor':(t.elapsedMs>0?'Duraklatıldı':'Henüz başlamadı');
  document.getElementById('timerStartBtn').textContent=t.elapsedMs>0?'Devam Et':'Başla';
  document.getElementById('timerStartBtn').disabled=running;
  document.getElementById('timerPauseBtn').disabled=!running;
}
function persistCurrentTimer(t){
  if(!activeBook) return;
  const all=getReadingTimers(); all[activeBook.id]=t; saveReadingTimers(all);
}
function startReadingTimer(){
  if(!activeBook) return;
  const t=currentReadingTimer();
  if(t.startedAt) return;
  t.startedAt=Date.now(); persistCurrentTimer(t);
  if(timerTick) clearInterval(timerTick);
  timerTick=setInterval(renderReadingTimer,250);
  renderReadingTimer();
}
function pauseReadingTimer(){
  if(!activeBook) return;
  const t=currentReadingTimer();
  if(t.startedAt){ t.elapsedMs=timerElapsed(t); t.startedAt=null; persistCurrentTimer(t); }
  if(timerTick){ clearInterval(timerTick); timerTick=null; }
  renderReadingTimer();
}
function finishReadingTimer(){
  if(!activeBook) return;
  const t=currentReadingTimer();
  if(t.startedAt){ t.elapsedMs=timerElapsed(t); t.startedAt=null; }
  const duration=t.elapsedMs||0;
  if(duration>0){
    t.totalMs=(t.totalMs||0)+duration;
    t.sessions=t.sessions||[];
    t.sessions.push({date:new Date().toISOString(),durationMs:duration,page:activeBook.type==='pdf'?(activeBook.currentPage||1):Math.round((activeBook.scrollRatio||0)*estimatePages(activeBook))});
  }
  t.elapsedMs=0; persistCurrentTimer(t);
  if(timerTick){ clearInterval(timerTick); timerTick=null; }
  renderReadingTimer();
  showToast('Okuma oturumu kaydedildi: '+formatReadingTime(duration));
}
function resetReadingTimer(){
  if(!activeBook) return;
  if(!confirm('Bu oturumun süresini sıfırlamak istiyor musun?')) return;
  const t=currentReadingTimer(); t.elapsedMs=0; t.startedAt=null; persistCurrentTimer(t);
  if(timerTick){ clearInterval(timerTick); timerTick=null; }
  renderReadingTimer(); showToast('Oturum süresi sıfırlandı');
}
function restartReading(){
  if(!activeBook) return;
  if(!confirm('Kitabı ilk sayfaya döndürüp okuma süresini sıfırlamak istiyor musun?')) return;
  const t=currentReadingTimer(); t.elapsedMs=0; t.startedAt=null; persistCurrentTimer(t);
  if(timerTick){ clearInterval(timerTick); timerTick=null; }
  if(activeBook.type==='pdf'){
    currentPdfPage=1; activeBook.currentPage=1; renderPdfPage(1);
  } else {
    activeBook.scrollRatio=0;
    const books=getBooks(), b=books.find(x=>x.id===activeBook.id); b.scrollRatio=0; b.status='reading'; saveBooks(books);
    document.getElementById('readerBody').scrollTop=0; updateTextProgressDisplay();
  }
  renderReadingTimer(); showToast('Kitap ve oturum baştan başlatıldı');
}

/* ---------------- Init ---------------- */
window.addEventListener('DOMContentLoaded', async ()=>{
  window.appStorageReady = openDB();
  await window.appStorageReady;
  showQuote();
  refreshStreakDisplay();
  renderLibrary();
  renderReadingBookmark();
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
    const newBook={id, title, author, type:'pdf', totalPages, currentPage:1, status:'reading', addedDate:todayStr(), lastReadDate:null, updatedAt:Date.now()};
    books.push(newBook); saveBooks(books);
    if(window.cloudUploadFile) window.cloudUploadFile(id, bytes, 'pdf').catch(window.cloudSyncError);
  } else {
    const text = document.getElementById('inpText').value;
    if(!text.trim()){ showToast('Lütfen metni yapıştır'); return; }
    await idbSet('texts', id, text);
    const books = getBooks();
    const newBook={id, title, author, type:'text', charCount:text.length, scrollRatio:0, status:'reading', addedDate:todayStr(), lastReadDate:null, updatedAt:Date.now()};
    books.push(newBook); saveBooks(books);
    if(window.cloudUploadFile) window.cloudUploadFile(id, new TextEncoder().encode(text), 'text').catch(window.cloudSyncError);
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
  if(window.cloudDeleteBook) window.cloudDeleteBook(id).catch(window.cloudSyncError);
  renderLibrary();
  showToast('Kitap silindi');
}

/* ---------------- Reader: open/close ---------------- */
async function openReader(id){
  const books = getBooks();
  activeBook = books.find(b=>b.id===id);
  if(!activeBook) return;
  const openingBook=activeBook;
  sessionStartPage = activeBook.type==='pdf' ? (activeBook.currentPage||1) : Math.round((activeBook.scrollRatio||0)*estimatePages(activeBook));

  document.getElementById('readerTitle').textContent = activeBook.title;
  timerBookId = activeBook.id;
  const reader=document.getElementById('reader');
  reader.classList.remove('immersive');
  reader.classList.add('show');
  const immersiveBtn=document.getElementById('immersiveBtn');
  if(immersiveBtn) immersiveBtn.textContent='⛶ Tam Ekran';
  renderReadingTimer();
  if(currentReadingTimer().startedAt){
    if(timerTick) clearInterval(timerTick);
    timerTick=setInterval(renderReadingTimer,250);
  }

  try{
    const canvas=document.getElementById('pdfCanvas');
    const textPage=document.getElementById('textPage');
    if(activeBook.type==='pdf'){
      canvas.style.display='block';
      textPage.style.display='none';
      document.getElementById('pdfFooter').style.display='flex';
      document.getElementById('fontBtns').style.display='none';
      document.getElementById('rotateBtn').style.display='inline-block';
      pdfRotation=0;

      let stored=await idbGet('pdfs',id);
      if(!stored && window.cloudDownloadFile){
        const downloaded=await window.cloudDownloadFile(id);
        stored=downloaded;
      }
      if(!stored) throw new Error('PDF dosyası bu cihazda veya bulut hesabında bulunamadı. Diğer cihazda Google ile giriş yapıp dosyanın yüklenmesini bekle.');
      const bytes=stored instanceof Uint8Array ? stored : new Uint8Array(stored);
      if(bytes.byteLength<8) throw new Error('PDF dosyası boş veya eksik indirilmiş.');
      const signature=new TextDecoder().decode(bytes.subarray(0,5));
      if(signature!=='%PDF-') throw new Error('İndirilen dosya geçerli bir PDF değil. Dosyayı yeniden yüklemek gerekebilir.');

      pdfDoc=await pdfjsLib.getDocument({data:bytes}).promise;
      currentPdfPage=Math.min(Math.max(1,openingBook.currentPage||1),pdfDoc.numPages);
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      await renderPdfPage(currentPdfPage);
      window.addEventListener('resize',onReaderResize);
    } else {
      canvas.style.display='none';
      textPage.style.display='block';
      document.getElementById('pdfFooter').style.display='none';
      document.getElementById('fontBtns').style.display='flex';
      document.getElementById('rotateBtn').style.display='none';
      let text=await idbGet('texts',id);
      if(!text && window.cloudDownloadFile){
        await window.cloudDownloadFile(id);
        text=await idbGet('texts',id);
      }
      if(!text) throw new Error('Kitap metni bu cihazda veya bulut hesabında bulunamadı.');
      textPage.style.fontSize=(fontSize*readerZoom/100)+'px';
      textPage.textContent=text;
      const body=document.getElementById('readerBody');
      setTimeout(()=>{body.scrollTop=(openingBook.scrollRatio||0)*(body.scrollHeight-body.clientHeight);},30);
      body.onscroll=onTextScroll;
      updateTextProgressDisplay();
    }
  }catch(error){
    console.error('Kitap açma hatası:',error);
    pauseReadingTimer();
    reader.classList.remove('show','immersive');
    document.getElementById('readerBody').onscroll=null;
    canvasOrTextCleanup();
    pdfDoc=null;
    activeBook=null;
    showToast('Kitap açılamadı: '+(error.message||'Dosya yüklenemedi'));
  }
}
function canvasOrTextCleanup(){
  document.getElementById('pdfCanvas').style.display='none';
  document.getElementById('textPage').style.display='none';
  window.removeEventListener('resize',onReaderResize);
}

function closeReader(){
  pauseReadingTimer();
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
window.addEventListener('orientationchange', ()=>{
  // iOS'ta boyutlar dönüşten hemen sonra güncellenmeyebiliyor, kısa gecikmeyle tekrar dene
  setTimeout(()=>{ if(pdfDoc && currentPdfPage) renderPdfPage(currentPdfPage); }, 200);
});
function rotatePage(){
  pdfRotation = (pdfRotation + 90) % 360;
  if(pdfDoc) renderPdfPage(currentPdfPage);
}

function toggleReaderImmersive(){
  const reader=document.getElementById('reader');
  if(!reader.classList.contains('show')) return;
  const enabled=reader.classList.toggle('immersive');
  const btn=document.getElementById('immersiveBtn');
  if(btn) btn.textContent=enabled?'⤢ Normal Görünüm':'⛶ Tam Ekran';
  // Sayfa yeni kullanılabilir alana göre yeniden çizilsin.
  if(pdfDoc && currentPdfPage) requestAnimationFrame(()=>renderPdfPage(currentPdfPage));
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
  const availW = Math.max(200, body.clientWidth - 12);
  const availH = Math.max(200, body.clientHeight - 12);
  const baseViewport = page.getViewport({scale: 1, rotation: pdfRotation});
  // Tam ekran modunda sayfayı yüksekliğe göre küçültme; genişliğe yay ve dikey kaydırmaya izin ver.
  const immersive = document.getElementById('reader').classList.contains('immersive');
  const fitScale = immersive
    ? (availW / baseViewport.width)
    : Math.min(availW / baseViewport.width, availH / baseViewport.height);
  // Kullanıcının yüzde ayarı, ekrana sığdırılmış temel boyuta uygulanır.
  const scale = fitScale * (readerZoom / 100);
  const viewport = page.getViewport({scale: Math.max(scale, 0.2), rotation: pdfRotation});

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
  b.lastReadDate = todayStr(); b.updatedAt=Date.now();
  if(num >= b.totalPages) b.status='finished';
  saveBooks(books);
  activeBook = b;
  syncReadingBookmark(b,num);
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
  b.lastReadDate = todayStr(); b.updatedAt=Date.now();
  if(ratio >= 0.98) b.status='finished';
  saveBooks(books);
  activeBook = b;
  syncReadingBookmark(b, Math.max(1,Math.round(ratio*estimatePages(b))));
  document.getElementById('readerProgressFill').style.width = Math.round(ratio*100)+'%';
  if(ratio>=0.98 && force!==false) celebrateFinish();
}
function updateTextProgressDisplay(){
  document.getElementById('readerProgressFill').style.width = Math.round((activeBook.scrollRatio||0)*100)+'%';
}
function setReaderZoom(value){
  readerZoom=Math.max(60,Math.min(150,Number(value)||100));
  const slider=document.getElementById('readerZoom');
  const label=document.getElementById('readerZoomValue');
  if(slider) slider.value=readerZoom;
  if(label) label.textContent=readerZoom+'%';
  if(pdfDoc && currentPdfPage) renderPdfPage(currentPdfPage);
  else {
    const page=document.getElementById('textPage');
    if(page) page.style.fontSize=(fontSize*readerZoom/100)+'px';
  }
}
function adjustReaderZoom(delta){ setReaderZoom(readerZoom+delta); }
function changeFont(delta){
  fontSize = Math.max(13, Math.min(26, fontSize+delta*1));
  document.getElementById('textPage').style.fontSize = (fontSize*readerZoom/100)+'px';
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