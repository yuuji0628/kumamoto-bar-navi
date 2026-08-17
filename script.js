const escHtml=s=>String(s??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]));

function kbnCleanName(v){
  return String(v||"")
    .replace(/^【KBN独自掲載】/,"")
    .replace(/\s*[（(]\s*@[A-Za-z0-9._]+\s*[）)]\s*$/,"")
    .replace(/\s+@[A-Za-z0-9._]+\s*$/,"")
    .trim();
}
function kbnIsEditorial(s){
  return String(s?.listing_status||"")==="provisional" || /^【KBN独自掲載】/.test(String(s?.name||""));
}
function kbnNormalizeArea(v){
  const s=String(v||"").trim();
  const aliases={
    "八代郡氷川町":"氷川町","葦北郡芦北町":"芦北町","葦北郡津奈木町":"津奈木町",
    "下益城郡美里町":"美里町","天草郡苓北町":"苓北町"
  };
  if(aliases[s])return aliases[s];
  if(/^熊本市.+区$/.test(s))return "熊本市";
  return s;
}
function kbnTokens(v){
  return String(v||"").split(/[、,／/・\s]+/).map(x=>x.trim()).filter(Boolean);
}
function kbnMoney(s){
  const min=Number(s?.budget_min||0),max=Number(s?.budget_max||0);
  if(min&&max&&min!==max)return `${min.toLocaleString()}〜${max.toLocaleString()}円`;
  if(min)return `${min.toLocaleString()}円〜`;
  if(max)return `〜${max.toLocaleString()}円`;
  return "";
}
function kbnCard(s){
  const name=kbnCleanName(s.name);
  const image=s.image_url||"default-bar.svg";
  const features=kbnTokens(s.features).slice(0,2);
  const money=kbnMoney(s);
  return `<a class="public-featured-card" href="shop.html?slug=${encodeURIComponent(s.slug)}">
    <div class="public-featured-photo${s.image_url?"":" is-placeholder"}">
      <img src="${escHtml(image)}" alt="${escHtml(name)}" loading="lazy" onerror="this.onerror=null;this.src='default-bar.svg'">
      ${s.is_new?'<span class="public-photo-badge">NEW</span>':""}
    </div>
    <div class="public-featured-body">
      <div class="public-card-meta">
        ${kbnIsEditorial(s)?'<span class="public-editorial-badge">KBN独自掲載</span>':""}
        ${s.is_featured?'<span class="public-recommend-badge">おすすめ</span>':""}
      </div>
      <h3>${escHtml(name)}</h3>
      <div class="public-card-tags">
        ${s.area?`<span>${escHtml(kbnNormalizeArea(s.area))}</span>`:""}
        ${s.genre?`<span>${escHtml(s.genre)}</span>`:""}
        ${features.map(x=>`<span>${escHtml(x)}</span>`).join("")}
      </div>
      <div class="public-card-facts">
        ${s.hours?`<span><small>営業時間</small><b>${escHtml(s.hours)}</b></span>`:""}
        ${money?`<span><small>料金目安</small><b>${escHtml(money)}</b></span>`:""}
      </div>
      <strong class="public-card-link">店舗を見る <i>›</i></strong>
    </div>
  </a>`;
}

async function loadHomeShops(){
  const featuredBox=document.getElementById("barCards");
  const latestBox=document.getElementById("homeLatestBars");
  if(!featuredBox&&!latestBox)return;

  try{
    const r=await fetch("/api/shops",{cache:"no-store"});
    const d=await r.json();
    if(!r.ok||!d.ok)throw new Error("LOAD_FAILED");
    const shops=d.shops||[];

    if(featuredBox){
      let featured=shops.filter(s=>Number(s.is_featured)===1).slice(0,6);
      if(!featured.length)featured=shops.slice(0,6);
      featuredBox.innerHTML=featured.length?featured.map(kbnCard).join(""):'<div class="public-empty"><b>おすすめ店舗を準備中です。</b></div>';
    }

    if(latestBox){
      const latest=[...shops].sort((a,b)=>Number(b.id||0)-Number(a.id||0)).slice(0,5);
      latestBox.innerHTML=latest.length?latest.map(s=>{
        const name=kbnCleanName(s.name);
        return `<a href="shop.html?slug=${encodeURIComponent(s.slug)}" class="public-latest-item">
          <div>
            <small>${escHtml(kbnNormalizeArea(s.area)||"熊本県")} ${s.genre?`/ ${escHtml(s.genre)}`:""}</small>
            <b>${escHtml(name)}</b>
          </div>
          <span>${kbnIsEditorial(s)?'<em>KBN独自掲載</em>':""} ›</span>
        </a>`;
      }).join(""):'<div class="public-empty"><b>新着店舗はありません。</b></div>';
    }
  }catch{
    if(featuredBox)featuredBox.innerHTML='<div class="public-empty"><b>おすすめ店舗を読み込めませんでした。</b></div>';
    if(latestBox)latestBox.innerHTML='<div class="public-empty"><b>新着店舗を読み込めませんでした。</b></div>';
  }
}

async function loadHomeNews(){
  const box=document.getElementById("kbnAutoNews");
  const countEl=document.getElementById("kbnNewsCount");
  if(!box)return;

  const fmt=v=>{
    try{
      const raw=String(v||"");
      const dt=new Date(raw.includes("T")?raw:raw.replace(" ","T")+"Z");
      if(Number.isNaN(dt.getTime()))return {short:"NEW",full:""};
      return {
        short:`${dt.getMonth()+1}/${dt.getDate()}`,
        full:`${dt.getFullYear()}.${String(dt.getMonth()+1).padStart(2,"0")}.${String(dt.getDate()).padStart(2,"0")}`
      };
    }catch{return {short:"NEW",full:""}}
  };

  try{
    const r=await fetch("/api/news",{cache:"no-store"});
    const d=await r.json();
    if(!r.ok||!d.ok)throw new Error();

    // NEWSは最大8件取得。スマホでは最初の3件を表示し、件数バッジで開閉する。
    const items=(d.news||[]).slice(0,8);
    let expanded=false;

    const href=x=>x.slug?`shop.html?slug=${encodeURIComponent(x.slug)}`:"bars.html";
    const title=x=>`${kbnCleanName(x.name||"店舗")} を正式掲載しました`;

    const render=()=>{
      const visible=expanded?items:items.slice(0,3);
      box.innerHTML=`<div class="public-news-equal-grid-v120">${visible.map((x,i)=>{
        const date=fmt(x.date||x.published_at||x.created_at);
        const name=kbnCleanName(x.name||"店舗");

        return `<a href="${href(x)}" class="public-news-equal-card-v120${i===0?" is-latest":""}">
          <div class="public-news-equal-date-v120">
            <time>${escHtml(date.short)}</time>
          </div>

          <div class="public-news-equal-body-v120">
            <div class="public-news-equal-badges-v120">
              ${i===0?'<span class="news-new-v120">NEW</span>':""}
              <span class="news-official-v120">正式掲載</span>
            </div>

            <b>${escHtml(title(x))}</b>
            <small>${escHtml(name)}の店舗ページを公開しました。</small>
          </div>

          <div class="public-news-equal-arrow-v120">›</div>
        </a>`;
      }).join("")}</div>`;

      if(countEl){
        countEl.textContent=items.length>3
          ? `${items.length}件 ${expanded?"▲":"▼"}`
          : `${items.length}件`;
        countEl.style.cursor=items.length>3?"pointer":"default";
        countEl.style.userSelect="none";
        countEl.setAttribute("role",items.length>3?"button":"status");
        countEl.setAttribute("tabindex",items.length>3?"0":"-1");
        countEl.setAttribute("aria-expanded",String(expanded));
        countEl.setAttribute("aria-label",items.length>3
          ? (expanded?"お知らせを3件表示に戻す":"お知らせをすべて表示する")
          : `お知らせ${items.length}件`);
      }
    };

    if(!items.length){
      if(countEl)countEl.textContent="0件";
      box.innerHTML='<div class="public-empty"><b>現在、お知らせはありません。</b></div>';
      return;
    }

    render();

    if(countEl && items.length>3){
      const toggle=()=>{
        expanded=!expanded;
        render();
        if(expanded){
          setTimeout(()=>box.scrollIntoView({behavior:"smooth",block:"nearest"}),50);
        }
      };
      countEl.onclick=toggle;
      countEl.onkeydown=e=>{
        if(e.key==="Enter"||e.key===" "){
          e.preventDefault();
          toggle();
        }
      };
    }
  }catch{
    if(countEl)countEl.textContent="0件";
    box.innerHTML='<div class="public-empty"><b>お知らせを読み込めませんでした。</b></div>';
  }
}

document.getElementById("homeSearchForm")?.addEventListener("submit",e=>{
  e.preventDefault();
  const area=document.getElementById("homeArea")?.value||"";
  const genre=document.getElementById("homeGenre")?.value||"";
  const q=document.getElementById("homeKeyword")?.value.trim()||"";
  const p=new URLSearchParams();
  if(area)p.set("area",area);
  if(genre)p.set("genre",genre);
  if(q)p.set("q",q);
  location.href="bars.html"+(p.toString()?`?${p}`:"");
});

loadHomeShops();
loadHomeNews();
