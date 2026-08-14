
const escHtml=s=>String(s??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]));

function featureTokens(value){
  return String(value||"").split(/[、,／/・\s]+/).map(x=>x.trim()).filter(Boolean);
}

async function loadFeaturedBars(){
  const box=document.getElementById("barCards");
  if(!box)return;

  try{
    const r=await fetch("/api/shops",{cache:"no-store"});
    const d=await r.json();
    if(!r.ok||!d.ok)throw new Error("LOAD_FAILED");

    const featured=(d.shops||[])
      .filter(s=>Number(s.is_published)===1 && Number(s.is_featured)===1);

    if(!featured.length){
      box.innerHTML='<p class="note">現在、おすすめ店舗を準備中です。</p>';
      return;
    }

    box.innerHTML=featured.map(s=>{
      const features=featureTokens(s.features);
      const badges=[
        s.area||"",
        s.genre||"",
        features[0]||""
      ].filter(Boolean).slice(0,3);

      const image=s.image_url
        ? `<img src="${escHtml(s.image_url)}" alt="${escHtml(s.name)}" loading="lazy" onerror="this.onerror=null;this.src='default-bar.svg'">`
        : `<img src="default-bar.svg" alt="${escHtml(s.name)} 画像準備中" loading="lazy">`;

      return `
        <a class="bar-card featured-link"
           href="shop.html?slug=${encodeURIComponent(s.slug)}"
           data-area="${escHtml(s.area||"")}"
           data-genre="${escHtml(s.genre||"")}"
           data-types="${escHtml(s.features||"")}"
           data-name="${escHtml(s.name||"")}">
          <div class="card-image has-default-image">${image}</div>
          <div class="card-body">
            <h3>${escHtml(s.name)}</h3>
            <div class="badges">${badges.map(x=>`<span>${escHtml(x)}</span>`).join("")}</div>
            <p>${escHtml(s.description||"")}</p>
          </div>
        </a>`;
    }).join("");
  }catch(e){
    box.innerHTML='<p class="note">おすすめ店舗を読み込めませんでした。</p>';
  }
}

loadFeaturedBars();

const menuBtn=document.getElementById('menuBtn');
const nav=document.getElementById('nav');
menuBtn?.addEventListener('click',()=>{
  nav.classList.toggle('open');
  menuBtn.setAttribute('aria-expanded',nav.classList.contains('open'));
});
nav?.querySelectorAll('a').forEach(a=>a.addEventListener('click',()=>nav.classList.remove('open')));

function applyFilters(){
  const area=document.getElementById('areaFilter')?.value || 'all';
  const genre=document.getElementById('genreFilter')?.value || 'all';
  const feature=document.getElementById('featureFilter')?.value || 'all';
  const kw=(document.getElementById('keyword')?.value || '').trim().toLowerCase();

  let count=0;
  document.querySelectorAll('.bar-card').forEach(card=>{
    const cardArea=card.dataset.area || '';
    const cardGenre=card.dataset.genre || '';
    const cardTypes=card.dataset.types || '';
    const haystack=(card.dataset.name+' '+card.innerText+' '+cardGenre+' '+cardTypes).toLowerCase();

    const okArea=area==='all'||cardArea===area;
    const okGenre=genre==='all'||cardGenre.includes(genre);
    const okFeature=feature==='all'||cardTypes.includes(feature);
    const okKw=!kw||haystack.includes(kw);

    const show=okArea&&okGenre&&okFeature&&okKw;
    card.style.display=show?'':'none';
    if(show) count++;
  });

  const noResult=document.getElementById('noResult');
  if(noResult) noResult.style.display=count===0?'block':'none';

  document.getElementById('search')?.scrollIntoView({behavior:'smooth'});
}

document.getElementById('filterBtn')?.addEventListener('click',applyFilters);
document.getElementById('keyword')?.addEventListener('keydown',e=>{
  if(e.key==='Enter') applyFilters();
});
