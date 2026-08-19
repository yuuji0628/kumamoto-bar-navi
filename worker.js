
function kbnNormInstagram(v){
  let s=String(v||"").trim().toLowerCase();
  try{
    if(/^https?:\/\//i.test(s)){
      const u=new URL(s);
      const parts=u.pathname.split("/").filter(Boolean);
      s=parts[0]||"";
    }
  }catch{}
  return s.replace(/^@/,"").replace(/[^a-z0-9._]/g,"");
}

function kbnNormPhone(v){
  return String(v||"").replace(/\D/g,"");
}

function kbnNormAddress(v){
  return String(v||"")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[〒\s　,，.。・]/g,"")
    .replace(/[‐‑‒–—―ー−]/g,"-")
    .replace(/丁目/g,"-")
    .replace(/番地?/g,"-")
    .replace(/号/g,"")
    .replace(/-+/g,"-")
    .replace(/^-|-$/g,"");
}

function kbnNormShopName(v){
  return String(v||"")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/^【kbn独自掲載】/i,"")
    .replace(/\s*[（(]\s*@[a-z0-9._]+\s*[）)]\s*$/i,"")
    .replace(/\s+@[a-z0-9._]+\s*$/i,"")
    .replace(/[\s　"'’‘“”・･.,，。\-‐‑‒–—―ー_]/g,"")
    .replace(/(bar|バー)$/i,"")
    .trim();
}

function kbnDuplicateScore(sub,shop){
  const reasons=[];
  let score=0;
  let strong=false;

  const si=kbnNormInstagram(sub?.instagram);
  const xi=kbnNormInstagram(shop?.instagram);
  if(si && xi && si===xi){
    score+=100;
    strong=true;
    reasons.push("Instagram一致");
  }

  const sp=kbnNormPhone(sub?.phone);
  const xp=kbnNormPhone(shop?.phone);
  if(sp && xp && sp===xp){
    score+=95;
    strong=true;
    reasons.push("電話番号一致");
  }

  const sa=kbnNormAddress(sub?.address);
  const xa=kbnNormAddress(shop?.address);
  const addressExact=!!(sa && xa && sa===xa);
  if(addressExact){
    score+=80;
    reasons.push("住所一致");
  }

  const sn=kbnNormShopName(sub?.shop_name||sub?.name);
  const xn=kbnNormShopName(shop?.name);
  const nameExact=!!(sn && xn && sn===xn);
  if(nameExact){
    score+=60;
    reasons.push("店舗名一致");
  }else if(sn && xn && sn.length>=4 && xn.length>=4 && (sn.includes(xn)||xn.includes(sn))){
    score+=30;
    reasons.push("店舗名が類似");
  }

  // 住所+店名の一致は自動統合してよい強い一致。
  if(addressExact && nameExact)strong=true;

  return {
    score,
    strong,
    reasons,
    name_exact:nameExact,
    address_exact:addressExact
  };
}

async function findSubmissionDuplicate(env,sub){
  const r=await env.DB.prepare(`
    SELECT id,slug,name,area,address,phone,instagram,listing_status,is_published,
           hours,holiday,genre,features,description,budget_min,budget_max,seats,is_recruiting
    FROM shops
    ORDER BY id DESC
    LIMIT 1000
  `).all();

  const matches=[];
  for(const shop of (r.results||[])){
    const m=kbnDuplicateScore(sub,shop);
    if(m.score<30)continue;
    matches.push({
      shop_id:Number(shop.id),
      slug:shop.slug,
      name:shop.name,
      area:shop.area,
      address:shop.address,
      phone:shop.phone,
      instagram:shop.instagram,
      listing_status:shop.listing_status||"published",
      is_published:Number(shop.is_published||0),
      score:m.score,
      strong:m.strong,
      reasons:m.reasons
    });
  }

  matches.sort((a,b)=>b.score-a.score || b.shop_id-a.shop_id);
  return matches[0]||null;
}

function submissionArea(sub){
  return inferKumamotoAreaFromText(
    `${sub?.address||""} ${sub?.description||""}`,
    "熊本市"
  );
}

async function mergeSubmissionIntoShop(env,sub,shopId){
  const current=await env.DB.prepare("SELECT * FROM shops WHERE id=?").bind(shopId).first();
  if(!current)throw new Error("DUPLICATE_SHOP_NOT_FOUND");

  const area=submissionArea(sub);
  const next={
    name:t(sub.shop_name,180)||current.name,
    name_kana:current.name_kana,
    area:t(area,120)||current.area,
    address:t(sub.address,500)||current.address,
    hours:t(sub.hours,180)||current.hours,
    holiday:t(sub.holiday,180)||current.holiday,
    instagram:t(sub.instagram,500)||current.instagram,
    genre:t(sub.genre,180)||current.genre,
    features:t(sub.features,1500)||current.features,
    description:t(sub.description,5000)||current.description,
    budget_min:sub.budget_min!==null&&sub.budget_min!==undefined?ni(sub.budget_min):current.budget_min,
    budget_max:sub.budget_max!==null&&sub.budget_max!==undefined?ni(sub.budget_max):current.budget_max,
    seats:sub.seats!==null&&sub.seats!==undefined?ni(sub.seats):current.seats,
    phone:t(sub.phone,80)||current.phone,
    is_recruiting:b(sub.wants_job)||b(current.is_recruiting)
  };

  await env.DB.prepare(`
    UPDATE shops SET
      name=?,area=?,address=?,hours=?,holiday=?,instagram=?,genre=?,features=?,description=?,
      budget_min=?,budget_max=?,seats=?,phone=?,is_recruiting=?,
      listing_status='published',is_published=1,is_new=1,
      published_at=CASE
        WHEN COALESCE(listing_status,'published')='provisional' THEN CURRENT_TIMESTAMP
        ELSE COALESCE(published_at,CURRENT_TIMESTAMP)
      END,
      updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).bind(
    next.name,next.area,next.address,next.hours,next.holiday,next.instagram,next.genre,next.features,next.description,
    next.budget_min,next.budget_max,next.seats,next.phone,next.is_recruiting,shopId
  ).run();

  return await env.DB.prepare("SELECT * FROM shops WHERE id=?").bind(shopId).first();
}

function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}
const t=(v,m=4000)=>v===null||v===undefined?null:String(v).trim().slice(0,m);
const ni=v=>v===""||v===null||v===undefined?null:Number.parseInt(v,10);
const b=v=>v===true||v===1||v==="1"||v==="true"?1:0;
const slugify=v=>String(v||"").normalize("NFKC").toLowerCase().replace(/&/g,"-and-").replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,70)||`shop-${Date.now()}`;
const hasAccess=req=>Boolean(req.headers.get("Cf-Access-Authenticated-User-Email")||req.headers.get("Cf-Access-Jwt-Assertion"));



const KBN_GITHUB_EDITABLE_FILES = [
  "index.html",
  "style.css",
  "script.js",
  "admin.html",
  "worker.js",
  "wrangler.jsonc",
  "bars.html",
  "shop.html",
  "jobs.html",
  "areas.html"
];

function kbnGithubConfig(env){
  return {
    owner: t(env.GITHUB_OWNER || "yuuji0628", 100),
    repo: t(env.GITHUB_REPO || "kumamoto-bar-navi", 120),
    branch: t(env.GITHUB_BRANCH || "main", 100),
    token: String(env.GITHUB_TOKEN || "").trim()
  };
}

function kbnGithubHeaders(token){
  return {
    "Accept":"application/vnd.github+json",
    "Authorization":`Bearer ${token}`,
    "X-GitHub-Api-Version":"2022-11-28",
    "User-Agent":"KUMAMOTO-BAR-NAVI-ADMIN"
  };
}

function kbnUtf8ToBase64(value){
  const bytes=new TextEncoder().encode(String(value ?? ""));
  let bin="";
  const size=0x8000;
  for(let i=0;i<bytes.length;i+=size){
    bin+=String.fromCharCode(...bytes.subarray(i,i+size));
  }
  return btoa(bin);
}

function kbnBase64ToUtf8(value){
  const bin=atob(String(value||"").replace(/\n/g,""));
  const bytes=Uint8Array.from(bin,c=>c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function kbnGithubApi(env,path,init={}){
  const c=kbnGithubConfig(env);
  if(!c.token){
    const e=new Error("GITHUB_TOKEN_MISSING");
    e.status=503;
    throw e;
  }
  const r=await fetch(`https://api.github.com${path}`,{
    ...init,
    headers:{
      ...kbnGithubHeaders(c.token),
      ...(init.headers||{})
    }
  });
  const raw=await r.text();
  let data={};
  try{data=raw?JSON.parse(raw):{}}catch{data={message:raw}}
  if(!r.ok){
    const e=new Error(data?.message||`GITHUB_HTTP_${r.status}`);
    e.status=r.status;
    throw e;
  }
  return data;
}

function escHtml(v){
  return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

async function notifyNewSubmission(env, x){
  if(!env.RESEND_API_KEY) return {ok:false,error:"RESEND_API_KEY_NOT_BOUND"};

  const rows = [
    ["店舗名", x.shop_name],
    ["担当者名", x.contact_name],
    ["メール", x.email],
    ["電話番号", x.phone],
    ["住所", x.address],
    ["営業時間", x.hours],
    ["定休日", x.holiday],
    ["Instagram", x.instagram],
    ["ジャンル", x.genre],
    ["特徴", x.features],
    ["紹介文", x.description],
    ["予算", [x.budget_min,x.budget_max].filter(v=>v!==null&&v!==undefined&&v!=="").join("〜")],
    ["席数", x.seats],
    ["求人掲載希望", b(x.wants_job) ? "あり" : "なし"],
    ["備考", x.note]
  ];

  const htmlRows = rows.map(([k,v]) =>
    `<tr><th style="text-align:left;vertical-align:top;padding:10px;border-bottom:1px solid #ddd;width:120px">${escHtml(k)}</th><td style="padding:10px;border-bottom:1px solid #ddd;white-space:pre-wrap">${escHtml(v||"—")}</td></tr>`
  ).join("");

  const res = await fetch("https://api.resend.com/emails",{
    method:"POST",
    headers:{
      "Authorization":`Bearer ${env.RESEND_API_KEY}`,
      "Content-Type":"application/json"
    },
    body:JSON.stringify({
      from:"KUMAMOTO BAR NAVI <onboarding@resend.dev>",
      to:["kumamotobarnavi@gmail.com"],
      subject:`【KBN】新しい掲載申込み：${t(x.shop_name,80)||"店舗名未入力"}`,
      html:`<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111">
        <h2>新しい掲載申込みが届きました</h2>
        <p>KUMAMOTO BAR NAVI の掲載フォームから新しい申込みがありました。</p>
        <table style="border-collapse:collapse;width:100%;max-width:700px">${htmlRows}</table>
        <p style="margin-top:24px">管理画面の「申込み」タブから確認してください。</p>
      </body></html>`
    })
  });

  const body = await res.text();
  if(!res.ok) return {ok:false,error:"RESEND_ERROR",status:res.status,detail:body.slice(0,500)};
  return {ok:true};
}


async function notifyOwnerRequest(env, shop, requestType, payload, autoApplied=false){
  if(!env.RESEND_API_KEY) return {ok:false,error:"RESEND_API_KEY_NOT_BOUND"};

  const typeLabel={
    profile:"店舗情報変更",
    photo:"写真変更",
    job:"求人申請",
    event:"イベント申請",
    coupon:"クーポン申請"
  }[requestType]||requestType;

  const fieldLabel={
    name:"店舗名",
    name_kana:"読み方",
    area:"エリア",
    address:"住所",
    hours:"営業時間",
    holiday:"定休日",
    instagram:"Instagram",
    genre:"ジャンル",
    features:"特徴",
    description:"紹介文",
    budget_min:"予算下限",
    budget_max:"予算上限",
    seats:"席数",
    phone:"電話番号",
    image_url:"画像",
    title:"タイトル",
    employment_type:"雇用形態",
    salary:"給与",
    contact:"連絡先",
    note:"備考"
  };

  const rows=Object.entries(payload||{}).map(([k,v])=>{
    let value=v;
    if(Array.isArray(v)) value=v.join("、");
    if(v && typeof v==="object" && !Array.isArray(v)){
      try{value=JSON.stringify(v,null,2)}catch{value=String(v)}
    }
    return [fieldLabel[k]||k,value];
  });

  const htmlRows=rows.length
    ? rows.map(([k,v])=>
        `<tr>
          <th style="text-align:left;vertical-align:top;padding:10px;border-bottom:1px solid #ddd;width:130px">${escHtml(k)}</th>
          <td style="padding:10px;border-bottom:1px solid #ddd;white-space:pre-wrap;word-break:break-word">${escHtml(v??"—")}</td>
        </tr>`
      ).join("")
    : `<tr><td style="padding:10px">申請内容なし</td></tr>`;

  const statusText=autoApplied
    ? "店舗情報へ自動反映済み"
    : "管理画面で確認待ち";

  const res=await fetch("https://api.resend.com/emails",{
    method:"POST",
    headers:{
      "Authorization":`Bearer ${env.RESEND_API_KEY}`,
      "Content-Type":"application/json"
    },
    body:JSON.stringify({
      from:"KUMAMOTO BAR NAVI <onboarding@resend.dev>",
      to:["kumamotobarnavi@gmail.com"],
      subject:`【KBN】${typeLabel}：${t(shop?.name,80)||"店舗名未設定"}`,
      html:`<!doctype html>
      <html>
      <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111;line-height:1.6">
        <h2>店舗から変更申請が届きました</h2>

        <p>
          <strong>店舗：</strong>${escHtml(shop?.name||"—")}<br>
          <strong>申請種別：</strong>${escHtml(typeLabel)}<br>
          <strong>状態：</strong>${escHtml(statusText)}
        </p>

        <table style="border-collapse:collapse;width:100%;max-width:760px">
          ${htmlRows}
        </table>

        <p style="margin-top:24px">
          ${autoApplied
            ? "店舗情報変更は自動反映されています。内容をご確認ください。"
            : "管理画面の「店舗申請」タブから確認・反映してください。"}
        </p>

        <p>
          <a href="https://kumamoto-bar-navi.rrwpvwmz8p.workers.dev/admin-login"
             style="display:inline-block;padding:12px 18px;background:#111;color:#fff;text-decoration:none;border-radius:8px">
             管理画面を開く
          </a>
        </p>
      </body>
      </html>`
    })
  });

  const body=await res.text();
  if(!res.ok){
    return {
      ok:false,
      error:"RESEND_ERROR",
      status:res.status,
      detail:body.slice(0,500)
    };
  }

  return {ok:true};
}





function leadSearchConfig(env){
  return {
    apiKey:t(env.SERPAPI_API_KEY,1000)
  };
}

function extractInstagramHandleFromUrl(value){
  try{
    const u=new URL(value);
    const host=u.hostname.replace(/^www\./,"").toLowerCase();
    if(host!=="instagram.com")return "";
    const seg=u.pathname.split("/").filter(Boolean);
    const first=seg[0]||"";
    const reserved=new Set([
      "p","reel","reels","stories","explore","accounts","direct",
      "about","developer","legal","web","challenge"
    ]);
    if(!first || reserved.has(first.toLowerCase()))return "";
    return first.replace(/^@/,"").trim();
  }catch{
    return "";
  }
}


async function serpApiGoogleSearch(env,{q,start=0,num=10}){
  const cfg=leadSearchConfig(env);
  if(!cfg.apiKey){
    return {ok:false,configured:false,error:"SERPAPI_NOT_CONFIGURED",results:[]};
  }

  const u=new URL("https://serpapi.com/search.json");
  u.searchParams.set("engine","google");
  u.searchParams.set("q",String(q||""));
  u.searchParams.set("google_domain","google.co.jp");
  u.searchParams.set("gl","jp");
  u.searchParams.set("hl","ja");
  u.searchParams.set("num",String(Math.max(1,Math.min(Number(num)||10,10))));
  u.searchParams.set("start",String(Math.max(0,Number(start)||0)));
  u.searchParams.set("api_key",cfg.apiKey);

  const r=await fetch(u.toString(),{headers:{"Accept":"application/json"}});
  const text=await r.text();
  let d={};
  try{d=text?JSON.parse(text):{}}catch{d={raw:text}}

  if(!r.ok || d?.error){
    return {
      ok:false,
      configured:true,
      error:d?.error||d?.message||`SEARCH_HTTP_${r.status}`,
      results:[]
    };
  }

  return {
    ok:true,
    configured:true,
    results:Array.isArray(d?.organic_results)?d.organic_results:[]
  };
}

function normalizeJobText(v){
  return String(v||"")
    .replace(/[，,]/g,"")
    .replace(/\s+/g," ")
    .trim();
}

function likelyJobPosting(item){
  const text=normalizeJobText(`${item?.title||""} ${item?.snippet||""}`).toLowerCase();

  const good=[
    "求人","募集","スタッフ募集","アルバイト","バイト","採用",
    "バーテンダー","ホールスタッフ","正社員","パート","時給","月給",
    "staff wanted","hiring","recruit"
  ];

  const bad=[
    "求人情報まとめ","求人検索結果","転職サイト","求人サイトの口コミ",
    "閉店","募集終了","採用終了","応募終了"
  ];

  if(bad.some(x=>text.includes(x.toLowerCase())))return false;
  return good.some(x=>text.includes(x.toLowerCase()));
}

function extractJobEmployment(text){
  const s=normalizeJobText(text);
  if(/正社員|社員募集/.test(s))return "正社員";
  if(/アルバイト|バイト/.test(s))return "アルバイト";
  if(/パート/.test(s))return "パート";
  if(/業務委託/.test(s))return "業務委託";
  if(/契約社員/.test(s))return "契約社員";
  return "";
}

function extractJobSalary(text){
  const s=normalizeJobText(text);

  const patterns=[
    /(?:時給)\s*[¥￥]?\s*([0-9]{3,6})(?:\s*[〜～~\-]\s*[¥￥]?\s*([0-9]{3,6}))?\s*円?/i,
    /(?:日給)\s*[¥￥]?\s*([0-9]{3,6})(?:\s*[〜～~\-]\s*[¥￥]?\s*([0-9]{3,6}))?\s*円?/i,
    /(?:月給)\s*[¥￥]?\s*([0-9]{4,7})(?:\s*[〜～~\-]\s*[¥￥]?\s*([0-9]{4,7}))?\s*円?/i,
    /(?:給与|給料)\s*[:：]?\s*[¥￥]?\s*([0-9]{3,7})(?:\s*[〜～~\-]\s*[¥￥]?\s*([0-9]{3,7}))?\s*円?/i
  ];

  for(const p of patterns){
    const m=s.match(p);
    if(!m)continue;

    const label=m[0].match(/時給|日給|月給|給与|給料/)?.[0]||"給与";
    const a=Number(m[1]);
    const b=m[2]?Number(m[2]):null;
    if(!Number.isFinite(a))continue;

    return b && Number.isFinite(b)
      ? `${label} ${a.toLocaleString()}〜${b.toLocaleString()}円`
      : `${label} ${a.toLocaleString()}円`;
  }

  const yen=s.match(/[¥￥]\s*([0-9]{3,7})\s*(?:円)?/);
  if(yen)return `給与 ${Number(yen[1]).toLocaleString()}円`;

  return "";
}

function extractJobHours(text){
  const s=normalizeJobText(text);
  const patterns=[
    /(?:勤務時間|時間|シフト)\s*[:：]?\s*([0-2]?\d[:：]\d{2}\s*(?:[〜～~\-–—]|から)\s*(?:[0-2]?\d[:：]\d{2}|LAST))/i,
    /([0-2]?\d[:：]\d{2}\s*(?:[〜～~\-–—]|から)\s*(?:[0-2]?\d[:：]\d{2}|LAST))/i,
    /([0-2]?\d時(?:\d{1,2}分)?\s*(?:[〜～~\-–—]|から)\s*(?:[0-2]?\d時(?:\d{1,2}分)?|LAST))/i
  ];
  for(const p of patterns){
    const m=s.match(p);
    if(m)return String(m[1]).replace(/：/g,":").trim();
  }
  return "";
}

function extractJobTitle(text,shopName){
  const s=normalizeJobText(text);
  if(/バーテンダー/.test(s))return "バーテンダー募集";
  if(/ホールスタッフ|ホール/.test(s))return "ホールスタッフ募集";
  if(/スタッフ募集|スタッフ/.test(s))return "スタッフ募集";
  if(/アルバイト|バイト/.test(s))return "アルバイト募集";
  return `${String(shopName||"店舗").replace(/^【KBN独自掲載】/,"").trim()} スタッフ募集`;
}

function extractJobFeatures(text){
  const s=normalizeJobText(text);
  const labels=[];
  const pairs=[
    ["未経験歓迎",["未経験歓迎","未経験ok","未経験可"]],
    ["週1日〜",["週1","週１"]],
    ["週2日〜",["週2","週２"]],
    ["WワークOK",["wワーク","副業ok","副業可"]],
    ["髪型自由",["髪型自由"]],
    ["ネイルOK",["ネイルok","ネイル可"]],
    ["服装自由",["服装自由"]],
    ["交通費",["交通費"]],
    ["まかない",["まかない","賄い"]]
  ];
  const lower=s.toLowerCase();
  for(const [label,keys] of pairs){
    if(keys.some(k=>lower.includes(k.toLowerCase())))labels.push(label);
  }
  return labels.join("、");
}

function jobCandidateFromResult(item,shop){
  const title=t(item?.title,500)||"";
  const snippet=t(item?.snippet,3000)||"";
  const text=`${title} ${snippet}`;

  return {
    shop_id:Number(shop.id),
    shop_name:t(shop.name,180),
    title:extractJobTitle(text,shop.name),
    employment_type:extractJobEmployment(text),
    salary:extractJobSalary(text),
    hours:extractJobHours(text),
    features:extractJobFeatures(text),
    description:snippet,
    source_title:title,
    source_url:t(item?.link,2000),
    source_snippet:snippet
  };
}

async function ensureJobCandidatesTable(env){
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS job_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_id INTEGER NOT NULL,
      shop_name TEXT,
      title TEXT,
      employment_type TEXT,
      salary TEXT,
      hours TEXT,
      features TEXT,
      description TEXT,
      source_title TEXT,
      source_url TEXT,
      source_snippet TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reviewed_at TEXT
    )
  `).run();

  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_job_candidates_status
    ON job_candidates(status, created_at)
  `).run();
}

async function searchJobCandidatesForShops(env,{limit=5}={}){
  await ensureJobCandidatesTable(env);

  const max=Math.max(1,Math.min(Number(limit)||5,10));

  const r=await env.DB.prepare(`
    SELECT id,name,area,instagram,genre
    FROM shops
    WHERE is_published=1
    ORDER BY updated_at ASC,id ASC
    LIMIT ?
  `).bind(max).all();

  const shops=r.results||[];
  const created=[];
  const noHit=[];
  const failed=[];

  for(const shop of shops){
    try{
      const cleanName=String(shop.name||"").replace(/^【KBN独自掲載】/,"").replace(/\s*[（(]\s*@[A-Za-z0-9._]+\s*[）)]\s*$/,"").trim();
      const q=`"${cleanName}" ${shop.area||"熊本"} 求人 スタッフ募集 アルバイト バーテンダー`;

      const sr=await serpApiGoogleSearch(env,{q,num:10});

      if(!sr.ok){
        failed.push({shop_id:shop.id,shop_name:shop.name,reason:sr.error||"SEARCH_FAILED"});
        continue;
      }

      const candidates=(sr.results||[]).filter(likelyJobPosting).slice(0,2);

      if(!candidates.length){
        noHit.push({shop_id:shop.id,shop_name:shop.name});
        continue;
      }

      let made=0;
      for(const item of candidates){
        const c=jobCandidateFromResult(item,shop);
        if(!c.source_url)continue;

        const exists=await env.DB.prepare(`
          SELECT id FROM job_candidates
          WHERE shop_id=? AND source_url=? AND status IN ('pending','drafted','published')
          LIMIT 1
        `).bind(shop.id,c.source_url).first();

        if(exists)continue;

        const ir=await env.DB.prepare(`
          INSERT INTO job_candidates (
            shop_id,shop_name,title,employment_type,salary,hours,features,description,
            source_title,source_url,source_snippet,status
          )
          VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending')
        `).bind(
          c.shop_id,c.shop_name,c.title,c.employment_type,c.salary,c.hours,c.features,c.description,
          c.source_title,c.source_url,c.source_snippet
        ).run();

        created.push({...c,id:ir.meta?.last_row_id});
        made++;
      }

      if(!made)noHit.push({shop_id:shop.id,shop_name:shop.name,reason:"DUPLICATE_ONLY"});

    }catch(e){
      failed.push({
        shop_id:shop.id,
        shop_name:shop.name,
        reason:String(e?.message||e||"UNKNOWN_ERROR").slice(0,300)
      });
    }
  }

  return {ok:true,checked:shops.length,created,noHit,failed};
}

async function searchInstagramLeads(env,{area,type,start=1}){
  const cfg=leadSearchConfig(env);

  if(!cfg.apiKey){
    return {
      ok:false,
      configured:false,
      error:"SERPAPI_NOT_CONFIGURED"
    };
  }

  const typeWord={
    bar:"BAR", darts:"ダーツバー", karaoke:"カラオケバー", snack:"スナック",
    lounge:"ラウンジ", girls:"ガールズバー", shot:"ショットバー", sports:"スポーツバー",
    wine:"ワインバー", beer:"ビアバー", cocktail:"カクテルバー", music:"ミュージックバー",
    shisha:"シーシャバー", concept:"コンセプトバー"
  }[type]||"BAR";

  const q=`site:instagram.com ${area} ${typeWord} 熊本`;
  const page=Math.max(0,Math.floor((Math.max(1,Number(start)||1)-1)/10));

  const u=new URL("https://serpapi.com/search.json");
  u.searchParams.set("engine","google");
  u.searchParams.set("q",q);
  u.searchParams.set("google_domain","google.co.jp");
  u.searchParams.set("gl","jp");
  u.searchParams.set("hl","ja");
  u.searchParams.set("num","10");
  u.searchParams.set("start",String(page*10));
  u.searchParams.set("api_key",cfg.apiKey);

  const r=await fetch(u.toString(),{
    headers:{"Accept":"application/json"}
  });

  const text=await r.text();
  let d={};
  try{d=text?JSON.parse(text):{}}catch{d={raw:text}}

  if(!r.ok || d?.error){
    return {
      ok:false,
      configured:true,
      error:d?.error||d?.message||`SEARCH_HTTP_${r.status}`,
      detail:d
    };
  }

  const results=Array.isArray(d?.organic_results)?d.organic_results:[];
  const seen=new Set();
  const leads=[];

  for(const item of results){
    const link=t(item?.link,2000);
    const handle=extractInstagramHandleFromUrl(link);
    if(!handle || seen.has(handle.toLowerCase()))continue;
    seen.add(handle.toLowerCase());

    let title=t(item?.title,300)
      .replace(/\s*[•\-|]\s*Instagram.*$/i,"")
      .replace(/\(@?[^)]+\)\s*•\s*Instagram.*$/i,"")
      .trim();

    if(!title || /^Instagram$/i.test(title)){
      title=handle;
    }

    leads.push({
      handle,
      instagram:`@${handle}`,
      url:`https://www.instagram.com/${encodeURIComponent(handle)}/`,
      title,
      snippet:t(item?.snippet,700),
      area:t(area,120),
      type:t(typeWord,120)
    });
  }

  return {
    ok:true,
    configured:true,
    query:q,
    leads,
    total:Number(d?.search_information?.total_results||0)||null,
    next_start:results.length>=10 ? (page+1)*10+1 : null
  };
}


async function sha256hex(value){
  const buf=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(String(value)));
  return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,"0")).join("");
}
function ownerToken(){
  const a=new Uint8Array(32);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}
async function ownerShop(request,env){
  const token=request.headers.get("X-Owner-Token")||"";
  if(token.length<20)return null;
  const hash=await sha256hex(token);
  return await env.DB.prepare("SELECT * FROM shops WHERE owner_token_hash=? LIMIT 1").bind(hash).first();
}



const KBN_AREAS=["熊本市", "八代市", "人吉市", "荒尾市", "水俣市", "玉名市", "山鹿市", "菊池市", "宇土市", "上天草市", "宇城市", "阿蘇市", "天草市", "合志市", "美里町", "玉東町", "南関町", "長洲町", "和水町", "大津町", "菊陽町", "南小国町", "小国町", "産山村", "高森町", "西原村", "南阿蘇村", "御船町", "嘉島町", "益城町", "甲佐町", "山都町", "氷川町", "芦北町", "津奈木町", "錦町", "多良木町", "湯前町", "水上村", "相良村", "五木村", "山江村", "球磨村", "あさぎり町", "苓北町"];
const KBN_LEAD_TYPES=[["bar", "BAR"], ["darts", "ダーツバー"], ["karaoke", "カラオケバー"], ["snack", "スナック"], ["lounge", "ラウンジ"], ["girls", "ガールズバー"], ["shot", "ショットバー"], ["sports", "スポーツバー"], ["wine", "ワインバー"], ["beer", "ビアバー"], ["cocktail", "カクテルバー"], ["music", "ミュージックバー"], ["shisha", "シーシャバー"], ["concept", "コンセプトバー"]];

async function ensureLeadDiscoveryTables(env){
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS lead_discovery_runs(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      area TEXT NOT NULL,
      lead_type TEXT NOT NULL,
      searched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS lead_discovery_seen(
      instagram_handle TEXT PRIMARY KEY,
      first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      source_area TEXT,
      source_type TEXT,
      status TEXT NOT NULL DEFAULT 'seen'
    )
  `).run();
}

function kbnHandle(v){
  return String(v||"").replace(/^https?:\/\/(www\.)?instagram\.com\//i,"")
    .replace(/^@/,"").split(/[\/?#]/)[0].trim().toLowerCase();
}

async function autoDiscoveryPairs(env,limit=4){
  await ensureLeadDiscoveryTables(env);
  const r=await env.DB.prepare(`
    SELECT area,lead_type,MAX(searched_at) last_searched
    FROM lead_discovery_runs GROUP BY area,lead_type
  `).all();
  const m=new Map((r.results||[]).map(x=>[`${x.area}||${x.lead_type}`,x.last_searched||""]));
  const p=[];
  for(const area of KBN_AREAS)for(const [type,label] of KBN_LEAD_TYPES)
    p.push({area,type,label,last:m.get(`${area}||${type}`)||""});
  p.sort((a,b)=>(!a.last&&b.last)?-1:(a.last&&!b.last)?1:String(a.last).localeCompare(String(b.last)));
  return p.slice(0,Math.max(1,Math.min(Number(limit)||4,8)));
}

function likelyBar(x){
  const s=`${x.title||""} ${x.snippet||""}`.toLowerCase();
  const good=["bar","バー","ダーツ","カラオケ","スナック","ラウンジ","ガールズ","ショット","ワイン","ビア","カクテル","ミュージック","シーシャ","コンセプト"];
  const bad=["美容","ネイル","エステ","不動産","建設","病院","歯科","整体","学校","塾","求人情報","ニュース"];
  return !bad.some(w=>s.includes(w)) && good.some(w=>s.includes(w));
}


function extractPriceInfo(text){
  const raw=String(text||"");

  let s=raw
    .replace(/[，,]/g,"")
    .replace(/１/g,"1").replace(/２/g,"2").replace(/３/g,"3")
    .replace(/４/g,"4").replace(/５/g,"5").replace(/６/g,"6")
    .replace(/７/g,"7").replace(/８/g,"8").replace(/９/g,"9")
    .replace(/０/g,"0");

  // Mask non-price numbers before extracting prices.
  s=s
    .replace(/https?:\/\/\S+/gi," ")
    .replace(/\bwww\.\S+/gi," ")
    .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi," ")
    .replace(/(?:TEL|電話|PHONE|FAX|予約|お問い合わせ)?\s*[:：]?\s*(?:\+81[\s-]?(?:0)?|0)\d{1,4}[\s\-‐‑–—ー]?\d{1,4}[\s\-‐‑–—ー]?\d{3,4}\b/gi," ")
    .replace(/\b0\d{1,4}\s*\(\s*0?\d{1,4}\s*\)\s*\d{3,4}\b/g," ")
    .replace(/〒?\s*\d{3}[\s\-‐‑–—ー]\d{4}\b/g," ")
    .replace(/\b(?:[01]?\d|2[0-9])[:：]\d{2}(?::\d{2})?\b/g," ")
    .replace(/\b(?:[01]?\d|2[0-9])時(?:\d{1,2}分)?\b/g," ")
    .replace(/\b20\d{2}[\/.\-年]\d{1,2}(?:[\/.\-月]\d{1,2}日?)?\b/g," ")
    .replace(/\b\d{1,2}[\/.\-]\d{1,2}\b/g," ")
    .replace(/\b(?:緯度|経度|ID|店番号|店舗番号|郵便番号|フォロワー|followers?|口コミ|reviews?)\s*[:：]?\s*\d+(?:\.\d+)?\b/gi," ");

  const prices=[];

  function addPrice(v,score=1){
    const n=Number(String(v||"").replace(/[^\d]/g,""));
    if(!Number.isFinite(n) || n<100 || n>100000)return;
    prices.push({value:n,score});
  }

  const strongPatterns=[
    /[¥￥]\s*([0-9]{2,6})/g,
    /([0-9]{2,6})\s*円/g,
    /([0-9]{2,6})\s*(?:yen|JPY)/gi
  ];
  for(const p of strongPatterns){
    let m; while((m=p.exec(s)))addPrice(m[1],5);
  }

  const strongRanges=[
    /[¥￥]\s*([0-9]{2,6})\s*(?:〜|～|~|-|–|—|to)\s*[¥￥]?\s*([0-9]{2,6})(?:\s*円)?/gi,
    /([0-9]{2,6})\s*円\s*(?:〜|～|~|-|–|—|to)\s*([0-9]{2,6})\s*円?/gi
  ];
  for(const p of strongRanges){
    let m; while((m=p.exec(s))){addPrice(m[1],5);addPrice(m[2],5);}
  }

  const labels="料金|価格|予算|平均予算|price|チャージ|charge|セット料金|set料金|飲み放題|フリータイム|入場料|テーブルチャージ|席料|TC|SC|男性|女性|メンズ|レディース|お一人様|1名|一人";
  const contextual=[
    new RegExp(`(?:${labels})\\s*[:：]?\\s*[¥￥]?\\s*([0-9]{2,6})(?:\\s*円)?`,"gi"),
    /(?:from|starting at)\s*[¥￥]?\s*([0-9]{2,6})(?:\s*円)?/gi
  ];
  for(const p of contextual){
    let m; while((m=p.exec(s)))addPrice(m[1],4);
  }

  const contextualRange=new RegExp(
    `(?:${labels})\\s*[:：]?\\s*[¥￥]?\\s*([0-9]{2,6})\\s*(?:円)?\\s*(?:〜|～|~|-|–|—|to)\\s*[¥￥]?\\s*([0-9]{2,6})(?:\\s*円)?`,
    "gi"
  );
  let rm;
  while((rm=contextualRange.exec(s))){addPrice(rm[1],4);addPrice(rm[2],4);}

  if(!prices.length)return {min:null,max:null};
  const maxScore=Math.max(...prices.map(x=>x.score));
  const candidates=prices.filter(x=>x.score===maxScore).map(x=>x.value)
    .filter((v,i,a)=>a.indexOf(v)===i).sort((a,b)=>a-b);

  if(!candidates.length)return {min:null,max:null};
  if(candidates.length>1){
    const min=candidates[0],max=candidates[candidates.length-1];
    if(max/min>50)return {min:null,max:null};
    return {min,max};
  }
  return {min:candidates[0],max:candidates[0]};
}

function extractHoursInfo(text){
  const s=String(text||"");
  const patterns=[
    /(?:営業時間|open|hours?)\s*[:：]?\s*([0-2]?\d[:：]\d{2}\s*(?:[〜~\-–—]|から)\s*(?:[0-2]?\d[:：]\d{2}|LAST))/i,
    /([0-2]?\d[:：]\d{2}\s*(?:[〜~\-–—]|から)\s*(?:[0-2]?\d[:：]\d{2}|LAST))/i,
    /([0-2]?\d時(?:\d{1,2}分)?\s*(?:[〜~\-–—]|から)\s*(?:[0-2]?\d時(?:\d{1,2}分)?|LAST))/i
  ];
  for(const p of patterns){
    const m=s.match(p);
    if(m)return String(m[1]).replace(/：/g,":").trim();
  }
  return "";
}

function extractHolidayInfo(text){
  const s=String(text||"");
  const patterns=[
    /(?:定休日|店休日|休み|holiday)\s*[:：]?\s*([^\s、。|｜／/]{1,20}(?:曜日|曜|不定休|なし|無休)?)/i,
    /(月|火|水|木|金|土|日)曜日\s*(?:定休|休み)/,
    /(不定休|年中無休|無休)/
  ];
  for(const p of patterns){
    const m=s.match(p);
    if(!m)continue;
    if(m[1] && /^(月|火|水|木|金|土|日)$/.test(m[1]))return `${m[1]}曜日`;
    return String(m[1]||m[0]).replace(/定休|休み/g,"").trim();
  }
  return "";
}

function extractFeaturesInfo(text){
  const s=String(text||"").toLowerCase();
  const features=[];
  const dict=[
    ["ダーツ",["ダーツ","darts"]],
    ["カラオケ",["カラオケ","karaoke"]],
    ["飲み放題",["飲み放題","all you can drink"]],
    ["シーシャ",["シーシャ","shisha"]],
    ["個室",["個室","private room"]],
    ["カウンター",["カウンター","counter"]],
    ["貸切",["貸切"]],
    ["スポーツ観戦",["スポーツ観戦","sports bar"]],
    ["ワイン",["ワイン","wine"]],
    ["カクテル",["カクテル","cocktail"]]
  ];
  for(const [label,keys] of dict){
    if(keys.some(k=>s.includes(k.toLowerCase())))features.push(label);
  }
  return features.join("、");
}


const KBN_AREA_PATTERNS=[
  ["熊本市",/熊本市(?:中央区|東区|西区|南区|北区)?/],
  ["八代市",/八代市/],
  ["人吉市",/人吉市/],
  ["荒尾市",/荒尾市/],
  ["水俣市",/水俣市/],
  ["玉名市",/玉名市/],
  ["山鹿市",/山鹿市/],
  ["菊池市",/菊池市/],
  ["宇土市",/宇土市/],
  ["上天草市",/上天草市/],
  ["宇城市",/宇城市/],
  ["阿蘇市",/阿蘇市/],
  ["天草市",/天草市/],
  ["合志市",/合志市/],
  ["美里町",/(?:下益城郡)?美里町/],
  ["玉東町",/(?:玉名郡)?玉東町/],
  ["南関町",/(?:玉名郡)?南関町/],
  ["長洲町",/(?:玉名郡)?長洲町/],
  ["和水町",/(?:玉名郡)?和水町/],
  ["大津町",/(?:菊池郡)?大津町/],
  ["菊陽町",/(?:菊池郡)?菊陽町/],
  ["南小国町",/(?:阿蘇郡)?南小国町/],
  ["小国町",/(?:阿蘇郡)?小国町/],
  ["産山村",/(?:阿蘇郡)?産山村/],
  ["高森町",/(?:阿蘇郡)?高森町/],
  ["西原村",/(?:阿蘇郡)?西原村/],
  ["南阿蘇村",/(?:阿蘇郡)?南阿蘇村/],
  ["御船町",/(?:上益城郡)?御船町/],
  ["嘉島町",/(?:上益城郡)?嘉島町/],
  ["益城町",/(?:上益城郡)?益城町/],
  ["甲佐町",/(?:上益城郡)?甲佐町/],
  ["山都町",/(?:上益城郡)?山都町/],
  ["氷川町",/(?:八代郡)?氷川町/],
  ["芦北町",/(?:葦北郡)?芦北町/],
  ["津奈木町",/(?:葦北郡)?津奈木町/],
  ["錦町",/(?:球磨郡)?錦町/],
  ["多良木町",/(?:球磨郡)?多良木町/],
  ["湯前町",/(?:球磨郡)?湯前町/],
  ["水上村",/(?:球磨郡)?水上村/],
  ["相良村",/(?:球磨郡)?相良村/],
  ["五木村",/(?:球磨郡)?五木村/],
  ["山江村",/(?:球磨郡)?山江村/],
  ["球磨村",/(?:球磨郡)?球磨村/],
  ["あさぎり町",/(?:球磨郡)?あさぎり町/],
  ["苓北町",/(?:天草郡)?苓北町/]
];

function inferKumamotoAreaFromText(text,fallback=""){
  const s=String(text||"").replace(/\s+/g," ");
  for(const [area,re] of KBN_AREA_PATTERNS){
    if(re.test(s))return area;
  }
  return String(fallback||"").trim();
}

function inferLeadArea(lead,fallback=""){
  return inferKumamotoAreaFromText(
    `${lead?.title||""} ${lead?.snippet||""} ${lead?.address||""}`,
    fallback
  );
}

async function repairExistingIndependentListingAreas(env,{limit=100}={}){
  const max=Math.max(1,Math.min(Number(limit)||100,500));

  const r=await env.DB.prepare(`
    SELECT id,name,area,address,description,instagram,genre
    FROM shops
    WHERE COALESCE(listing_status,'published')='provisional'
    ORDER BY id ASC
    LIMIT ?
  `).bind(max).all();

  const rows=r.results||[];
  const updated=[];
  const unchanged=[];

  for(const shop of rows){
    const sourceText=[
      shop.address||"",
      shop.description||"",
      shop.name||""
    ].join(" ");

    const inferred=inferKumamotoAreaFromText(sourceText,"");

    if(!inferred || inferred===String(shop.area||"").trim()){
      unchanged.push({
        id:shop.id,
        name:shop.name,
        area:shop.area,
        reason:inferred?"SAME_AREA":"AREA_NOT_FOUND"
      });
      continue;
    }

    await env.DB.prepare(`
      UPDATE shops
      SET area=?,updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).bind(inferred,shop.id).run();

    updated.push({
      id:shop.id,
      name:shop.name,
      old_area:shop.area,
      new_area:inferred
    });
  }

  return {
    ok:true,
    checked:rows.length,
    updated,
    unchanged
  };
}



function normalizePlaceName(value){
  return String(value||"")
    .toLowerCase()
    .replace(/^【kbn独自掲載】/i,"")
    .replace(/\s*[（(]\s*@[a-z0-9._]+\s*[）)]\s*$/i,"")
    .replace(/\s+@[a-z0-9._]+\s*$/i,"")
    .replace(/\b(bar|cafe|club|lounge|snack|pub)\b/gi,"")
    .replace(/[・･\-‐‑–—―ー_.,，。'’"“”「」『』【】()[\]{}]/g,"")
    .replace(/\s+/g,"")
    .trim();
}

function placeNameMatchScore(a,b){
  const x=normalizePlaceName(a),y=normalizePlaceName(b);
  if(!x||!y)return 0;
  if(x===y)return 100;
  if(x.includes(y)||y.includes(x)){
    const short=Math.min(x.length,y.length),long=Math.max(x.length,y.length);
    return Math.round(72+24*(short/long));
  }
  const grams=s=>{
    const arr=Array.from(s),out=new Set();
    if(arr.length===1){out.add(arr[0]);return out;}
    for(let i=0;i<arr.length-1;i++)out.add(arr[i]+arr[i+1]);
    return out;
  };
  const gx=grams(x),gy=grams(y);
  let hit=0;
  for(const g of gx)if(gy.has(g))hit++;
  return Math.round((2*hit/Math.max(1,gx.size+gy.size))*100);
}

function osmTags(place){
  return place&&typeof place.tags==="object"?place.tags:{};
}

function osmPlaceName(place){
  const tags=osmTags(place);
  return String(tags.name||tags["name:ja"]||tags.brand||tags.operator||"").trim();
}

function osmAddress(place){
  const t=osmTags(place);
  if(t["addr:full"])return String(t["addr:full"]).trim();
  const parts=[
    t["addr:province"],
    t["addr:city"]||t["addr:town"]||t["addr:village"],
    t["addr:suburb"]||t["addr:quarter"]||t["addr:neighbourhood"],
    t["addr:street"],
    t["addr:housenumber"]
  ].filter(Boolean);
  return parts.join(" ").replace(/\s+/g," ").trim();
}

function osmPhone(place){
  const t=osmTags(place);
  return String(t["contact:phone"]||t.phone||t["contact:mobile"]||"").trim();
}

function osmWebsite(place){
  const t=osmTags(place);
  return String(t["contact:website"]||t.website||t.url||"").trim();
}

function osmInstagram(place){
  const t=osmTags(place);
  const raw=String(
    t["contact:instagram"]||t.instagram||t["social_media"]||""
  ).trim();
  if(raw){
    const h=kbnHandle(raw);
    if(h)return `https://www.instagram.com/${h}/`;
  }
  const website=osmWebsite(place);
  const h=kbnHandle(website);
  return h?`https://www.instagram.com/${h}/`:"";
}

function osmHours(place){
  return String(osmTags(place).opening_hours||"").trim();
}

function osmHoliday(place){
  const h=osmHours(place);
  if(!h)return "";
  const dayMap={Mo:"月",Tu:"火",We:"水",Th:"木",Fr:"金",Sa:"土",Su:"日"};
  const closed=[];
  for(const part of h.split(";")){
    if(!/\boff\b|closed|休/i.test(part))continue;
    const m=part.trim().match(/\b(Mo|Tu|We|Th|Fr|Sa|Su)\b/g);
    if(m)closed.push(...m.map(x=>dayMap[x]||x));
  }
  return [...new Set(closed)].map(x=>`${x}曜日`).join("・");
}

function osmFeatures(place){
  const t=osmTags(place);
  const vals=[];
  const amenity=String(t.amenity||"");
  if(amenity==="bar")vals.push("バー");
  if(amenity==="pub")vals.push("パブ");
  if(amenity==="nightclub")vals.push("ナイトクラブ");
  if(amenity==="karaoke_box")vals.push("カラオケ");
  if(t.smoking==="yes"||t.smoking==="separated")vals.push("喫煙可");
  if(t.outdoor_seating==="yes")vals.push("テラス席");
  if(t.wheelchair==="yes")vals.push("車椅子対応");
  if(t.live_music==="yes")vals.push("ライブ");
  if(t.darts==="yes")vals.push("ダーツ");
  if(t.karaoke==="yes")vals.push("カラオケ");
  return [...new Set(vals)].join("、");
}

function osmPlaceLooksLikeBar(place){
  const t=osmTags(place);
  const a=String(t.amenity||"").toLowerCase();
  const n=String(t.name||"").toLowerCase();
  return ["bar","pub","nightclub","karaoke_box"].includes(a)
    || /(bar|バー|スナック|ラウンジ|club|クラブ|ダーツ|カラオケ|シーシャ)/i.test(n);
}

function osmAreaHint(place){
  const t=osmTags(place);
  return String(
    t["addr:city"]||t["addr:town"]||t["addr:village"]||
    t["addr:suburb"]||t["addr:quarter"]||""
  ).trim();
}

function osmPlaceScore(place,{name="",area=""}={}){
  let score=placeNameMatchScore(name,osmPlaceName(place));
  const addr=osmAddress(place);
  const areaHint=osmAreaHint(place);
  if(area && (addr.includes(area)||areaHint.includes(area)))score+=18;
  else if(addr.includes("熊本")||areaHint.includes("熊本"))score+=8;
  if(osmPlaceLooksLikeBar(place))score+=12;
  if(osmPhone(place))score+=2;
  if(osmHours(place))score+=2;
  return score;
}

async function ensureOpenDataCacheTable(env){
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS open_data_cache(
      cache_key TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
}

async function getOpenDataCache(env,key,maxAgeHours=24){
  await ensureOpenDataCacheTable(env);
  const row=await env.DB.prepare(`
    SELECT payload,fetched_at FROM open_data_cache
    WHERE cache_key=?
      AND datetime(fetched_at)>=datetime('now',?)
  `).bind(String(key),`-${Math.max(1,Number(maxAgeHours)||24)} hours`).first();
  if(!row?.payload)return null;
  try{return JSON.parse(row.payload)}catch{return null}
}

async function setOpenDataCache(env,key,value){
  await ensureOpenDataCacheTable(env);
  await env.DB.prepare(`
    INSERT INTO open_data_cache(cache_key,payload,fetched_at)
    VALUES(?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(cache_key) DO UPDATE SET
      payload=excluded.payload,
      fetched_at=CURRENT_TIMESTAMP
  `).bind(String(key),JSON.stringify(value)).run();
}

async function fetchKumamotoOsmBars(env,{force=false}={}){
  const key="osm_kumamoto_bars_v1";
  if(!force){
    const cached=await getOpenDataCache(env,key,24);
    if(Array.isArray(cached))return {ok:true,source:"cache",places:cached};
  }

  const query=`
[out:json][timeout:40];
area["name"="熊本県"]["boundary"="administrative"]->.a;
(
  nwr(area.a)["amenity"~"^(bar|pub|nightclub|karaoke_box)$"];
);
out center tags;
  `.trim();

  const endpoints=[
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter"
  ];

  let lastError="OVERPASS_UNAVAILABLE";
  for(const endpoint of endpoints){
    try{
      const r=await fetch(endpoint,{
        method:"POST",
        headers:{
          "Content-Type":"application/x-www-form-urlencoded;charset=UTF-8",
          "User-Agent":"KUMAMOTO-BAR-NAVI/1.33"
        },
        body:"data="+encodeURIComponent(query)
      });
      const text=await r.text();
      if(!r.ok){lastError=`OVERPASS_HTTP_${r.status}`;continue;}
      const d=JSON.parse(text);
      const places=Array.isArray(d?.elements)?d.elements.filter(osmPlaceLooksLikeBar):[];
      await setOpenDataCache(env,key,places);
      return {ok:true,source:"overpass",places};
    }catch(e){
      lastError=String(e?.message||e||lastError);
    }
  }

  const stale=await getOpenDataCache(env,key,24*30);
  if(Array.isArray(stale))return {ok:true,source:"stale_cache",places:stale};
  return {ok:false,error:lastError,places:[]};
}


function geoapifyConfig(env){
  return {apiKey:t(env.GEOAPIFY_API_KEY,1000)};
}

function geoFeatureProps(feature){
  return feature&&typeof feature.properties==="object"?feature.properties:{};
}

function geoName(feature){
  const p=geoFeatureProps(feature);
  return String(p.name||p.address_line1||"").trim();
}

function geoAddress(feature){
  const p=geoFeatureProps(feature);
  return String(
    p.formatted||
    [p.address_line1,p.address_line2].filter(Boolean).join(" ")||
    ""
  ).replace(/\s+/g," ").trim();
}

function geoPhone(feature){
  const p=geoFeatureProps(feature);
  const ds=p.datasource?.raw||{};
  return String(
    p.contact?.phone||
    p.phone||
    ds.phone||
    ds["contact:phone"]||
    ds["contact:mobile"]||
    ""
  ).trim();
}

function geoWebsite(feature){
  const p=geoFeatureProps(feature);
  const ds=p.datasource?.raw||{};
  return String(
    p.website||
    p.contact?.website||
    ds.website||
    ds["contact:website"]||
    ""
  ).trim();
}

function geoInstagram(feature){
  const p=geoFeatureProps(feature);
  const ds=p.datasource?.raw||{};
  const raw=String(
    ds.instagram||
    ds["contact:instagram"]||
    p.contact?.instagram||
    ""
  ).trim();
  const h=kbnHandle(raw||geoWebsite(feature));
  return h?`https://www.instagram.com/${h}/`:"";
}

function geoHours(feature){
  const p=geoFeatureProps(feature);
  const ds=p.datasource?.raw||{};
  const h=
    p.opening_hours||
    p.openingHours||
    ds.opening_hours||
    ds["opening_hours"]||
    "";
  if(Array.isArray(h))return h.join(" / ");
  return String(h||"").trim();
}

function geoCategories(feature){
  const p=geoFeatureProps(feature);
  return Array.isArray(p.categories)?p.categories.map(String):[];
}

function geoLooksLikeBar(feature){
  const cats=geoCategories(feature).join(" ").toLowerCase();
  const n=geoName(feature).toLowerCase();
  return /catering\.(bar|pub)/.test(cats)
    || /(bar|バー|スナック|ラウンジ|pub|パブ|ダーツ|カラオケ|シーシャ)/i.test(n);
}

function geoAreaHint(feature){
  const p=geoFeatureProps(feature);
  return String(p.city||p.town||p.village||p.suburb||p.county||"").trim();
}

function geoPlaceScore(feature,{name="",area=""}={}){
  let score=placeNameMatchScore(name,geoName(feature));
  const addr=geoAddress(feature);
  const hint=geoAreaHint(feature);
  if(area&&(addr.includes(area)||hint.includes(area)))score+=18;
  else if(addr.includes("熊本")||String(geoFeatureProps(feature).state||"").includes("熊本"))score+=8;
  if(geoLooksLikeBar(feature))score+=12;
  if(geoPhone(feature))score+=2;
  if(geoHours(feature))score+=2;
  return score;
}

async function geoapifyGeocodeShop(env,{name,area}){
  const cfg=geoapifyConfig(env);
  if(!cfg.apiKey)return {ok:false,configured:false,error:"GEOAPIFY_NOT_CONFIGURED",features:[]};

  const u=new URL("https://api.geoapify.com/v1/geocode/search");
  u.searchParams.set("text",[name,area,"熊本県","日本"].filter(Boolean).join(" "));
  u.searchParams.set("filter","countrycode:jp");
  u.searchParams.set("lang","ja");
  u.searchParams.set("limit","10");
  u.searchParams.set("format","geojson");
  u.searchParams.set("apiKey",cfg.apiKey);

  try{
    const r=await fetch(u.toString(),{headers:{"Accept":"application/json"}});
    const text=await r.text();
    let d={};
    try{d=text?JSON.parse(text):{}}catch{d={}}
    if(!r.ok)return {ok:false,configured:true,error:`GEOAPIFY_HTTP_${r.status}`,features:[]};
    return {ok:true,configured:true,features:Array.isArray(d?.features)?d.features:[]};
  }catch(e){
    return {ok:false,configured:true,error:String(e?.message||e||"GEOAPIFY_ERROR"),features:[]};
  }
}

async function geoapifyPlaceDetails(env,placeId){
  const cfg=geoapifyConfig(env);
  if(!cfg.apiKey||!placeId)return {ok:false,feature:null};
  const u=new URL("https://api.geoapify.com/v2/place-details");
  u.searchParams.set("id",String(placeId));
  u.searchParams.set("features","details");
  u.searchParams.set("lang","ja");
  u.searchParams.set("apiKey",cfg.apiKey);
  try{
    const r=await fetch(u.toString(),{headers:{"Accept":"application/json"}});
    const d=await r.json().catch(()=>({}));
    const feature=Array.isArray(d?.features)?d.features[0]:null;
    return {ok:r.ok&&!!feature,feature};
  }catch{
    return {ok:false,feature:null};
  }
}

async function findGeoapifyPlaceForShop(env,{name,area}){
  const sr=await geoapifyGeocodeShop(env,{name,area});
  if(!sr.ok)return {ok:false,configured:!!sr.configured,error:sr.error,matched:false};

  const ranked=(sr.features||[])
    .filter(f=>geoLooksLikeBar(f))
    .map(feature=>({feature,score:geoPlaceScore(feature,{name,area})}))
    .sort((a,b)=>b.score-a.score);

  const best=ranked[0];
  if(!best||best.score<78)return {ok:true,configured:true,matched:false,score:best?.score||0};

  const placeId=geoFeatureProps(best.feature).place_id||"";
  const detail=placeId?await geoapifyPlaceDetails(env,placeId):{ok:false,feature:null};
  return {
    ok:true,configured:true,matched:true,
    feature:detail.ok&&detail.feature?detail.feature:best.feature,
    score:best.score,
    confidence:best.score>=100?"high":"medium",
    source:"geoapify"
  };
}

async function fetchKumamotoGeoapifyBars(env,{force=false}={}){
  const cfg=geoapifyConfig(env);
  if(!cfg.apiKey)return {ok:false,configured:false,error:"GEOAPIFY_NOT_CONFIGURED",features:[]};

  const key="geoapify_kumamoto_bars_v1";
  if(!force){
    const cached=await getOpenDataCache(env,key,24);
    if(Array.isArray(cached))return {ok:true,configured:true,source:"geoapify_cache",features:cached};
  }

  const u=new URL("https://api.geoapify.com/v2/places");
  u.searchParams.set("categories","catering.bar,catering.pub");
  // Kumamoto Prefecture broad bounding box: west,south,east,north
  u.searchParams.set("filter","rect:129.90,32.05,131.35,33.25");
  u.searchParams.set("lang","ja");
  u.searchParams.set("limit","100");
  u.searchParams.set("apiKey",cfg.apiKey);

  try{
    const r=await fetch(u.toString(),{headers:{"Accept":"application/json"}});
    const d=await r.json().catch(()=>({}));
    if(!r.ok)return {ok:false,configured:true,error:`GEOAPIFY_PLACES_HTTP_${r.status}`,features:[]};

    const features=(Array.isArray(d?.features)?d.features:[]).filter(geoLooksLikeBar);
    await setOpenDataCache(env,key,features);
    return {ok:true,configured:true,source:"geoapify",features};
  }catch(e){
    const stale=await getOpenDataCache(env,key,24*30);
    if(Array.isArray(stale))return {ok:true,configured:true,source:"geoapify_stale_cache",features:stale};
    return {ok:false,configured:true,error:String(e?.message||e||"GEOAPIFY_ERROR"),features:[]};
  }
}

function safeHttpUrl(value){
  try{
    const u=new URL(String(value||"").trim());
    return /^https?:$/.test(u.protocol)?u.toString():"";
  }catch{return ""}
}

function htmlToText(html){
  return String(html||"")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi," ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi," ")
    .replace(/<[^>]+>/g," ")
    .replace(/&nbsp;/gi," ")
    .replace(/&amp;/gi,"&")
    .replace(/&#39;/g,"'")
    .replace(/&quot;/gi,'"')
    .replace(/\s+/g," ")
    .trim();
}

async function fetchOfficialWebsiteMetadata(url){
  const target=safeHttpUrl(url);
  if(!target || /instagram\.com|facebook\.com|x\.com|twitter\.com/i.test(target)){
    return {ok:false,price:{min:null,max:null},hours:"",holiday:"",features:""};
  }
  try{
    const r=await fetch(target,{
      headers:{"User-Agent":"Mozilla/5.0 KUMAMOTO-BAR-NAVI/1.33"}
    });
    if(!r.ok)return {ok:false,price:{min:null,max:null},hours:"",holiday:"",features:""};
    const ct=String(r.headers.get("content-type")||"");
    if(!/text\/html|text\/plain/i.test(ct))return {ok:false,price:{min:null,max:null},hours:"",holiday:"",features:""};
    let html=await r.text();
    if(html.length>250000)html=html.slice(0,250000);
    const text=htmlToText(html);
    return {
      ok:true,
      price:extractPriceInfo(text),
      hours:extractHoursInfo(text),
      holiday:extractHolidayInfo(text),
      features:extractFeaturesInfo(text)
    };
  }catch{
    return {ok:false,price:{min:null,max:null},hours:"",holiday:"",features:""};
  }
}

async function findOpenDataPlaceForShop(env,{name,area}){
  const snap=await fetchKumamotoOsmBars(env);
  if(snap.ok){
    const ranked=snap.places
      .map(place=>({place,score:osmPlaceScore(place,{name,area})}))
      .sort((a,b)=>b.score-a.score);
    const best=ranked[0];
    if(best&&best.score>=78){
      return {
        ok:true,matched:true,kind:"osm",place:best.place,score:best.score,
        confidence:best.score>=100?"high":"medium",
        source:snap.source
      };
    }
  }

  // OSMで見つからない/一致度が低い場合だけGeoapifyを使用。
  const geo=await findGeoapifyPlaceForShop(env,{name,area});
  if(geo.ok&&geo.matched){
    return {
      ok:true,matched:true,kind:"geoapify",feature:geo.feature,score:geo.score,
      confidence:geo.confidence,source:geo.source
    };
  }

  // OSM/Geoapifyで一致しなかった場合だけFoursquareへフォールバック。
  const fsq=await findFoursquarePlaceForShop(env,{name,area});
  if(fsq.ok&&fsq.matched){
    return {
      ok:true,matched:true,kind:"foursquare",fsq_place:fsq.place,score:fsq.score,
      confidence:fsq.confidence,source:"foursquare"
    };
  }

  if(!snap.ok && !geo.configured && !fsq.configured){
    return {ok:false,error:snap.error||geo.error||fsq.error||"DISCOVERY_SOURCES_UNAVAILABLE",matched:false};
  }

  return {
    ok:true,matched:false,
    score:Math.max(Number(geo.score||0),Number(fsq.score||0)),
    source:snap.ok?snap.source:(geo.configured?"geoapify":(fsq.configured?"foursquare":"none"))
  };
}

async function ensureOpenSyncTable(env){
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS open_data_sync_state(
      shop_id INTEGER PRIMARY KEY,
      source_id TEXT,
      checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
}

async function recentlyCheckedOpenData(env,shopId,days=30){
  await ensureOpenSyncTable(env);
  const row=await env.DB.prepare(`
    SELECT checked_at FROM open_data_sync_state
    WHERE shop_id=?
      AND datetime(checked_at)>=datetime('now',?)
  `).bind(shopId,`-${Math.max(1,Number(days)||30)} days`).first();
  return !!row;
}

async function markOpenDataChecked(env,shopId,sourceId){
  await ensureOpenSyncTable(env);
  await env.DB.prepare(`
    INSERT INTO open_data_sync_state(shop_id,source_id,checked_at)
    VALUES(?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(shop_id) DO UPDATE SET
      source_id=excluded.source_id,
      checked_at=CURRENT_TIMESTAMP
  `).bind(shopId,String(sourceId||"")).run();
}

function sanitizeStoredBudget(minValue,maxValue){
  let min=Number(minValue||0)||null;
  let max=Number(maxValue||0)||null;
  const valid=v=>v==null||(Number.isFinite(v)&&v>=100&&v<=100000);
  if(!valid(min))min=null;
  if(!valid(max))max=null;
  if(min&&max&&max<min)[min,max]=[max,min];
  if(min&&max&&max/min>50)return {min:null,max:null,invalid:true};
  return {min,max,invalid:false};
}

function extractPublicMetadata(lead){
  const tgs=osmTags(lead||{});
  const rawPrice=[
    tgs.charge,tgs.fee,tgs.price,tgs["drink:price"],tgs["entry_fee"],tgs.description
  ].filter(Boolean).join(" ");
  const p=extractPriceInfo(rawPrice);
  return {
    budget_min:p.min,
    budget_max:p.max,
    hours:osmHours(lead),
    holiday:osmHoliday(lead),
    features:osmFeatures(lead)
  };
}

async function refreshIndependentListings(env,{limit=10,afterId=0,revalidate=false,force=false}={}){
  const max=Math.max(1,Math.min(Number(limit)||10,30));
  const cursor=Math.max(0,Number(afterId)||0);

  const r=await env.DB.prepare(`
    SELECT id,name,area,address,phone,instagram,genre,hours,holiday,features,budget_min,budget_max,listing_status
    FROM shops
    WHERE COALESCE(listing_status,'published')='provisional'
      AND id>?
    ORDER BY id ASC
    LIMIT ?
  `).bind(cursor,max).all();

  const rows=r.results||[];
  const updated=[],unchanged=[],failed=[];

  for(const shop of rows){
    try{
      if(!force&&!revalidate&&await recentlyCheckedOpenData(env,shop.id,30)){
        unchanged.push({id:shop.id,name:shop.name,reason:"CHECKED_WITHIN_30_DAYS"});
        continue;
      }

      const found=await findOpenDataPlaceForShop(env,{
        name:String(shop.name||"").replace(/^【KBN独自掲載】/,"").trim(),
        area:shop.area||"熊本"
      });

      if(!found.ok){
        failed.push({id:shop.id,name:shop.name,reason:found.error||"OPEN_DATA_ERROR"});
        continue;
      }

      const storedBudget=sanitizeStoredBudget(shop.budget_min,shop.budget_max);

      if(!found.matched){
        const changedBudget=
          Number(storedBudget.min||0)!==Number(shop.budget_min||0)||
          Number(storedBudget.max||0)!==Number(shop.budget_max||0);

        if(changedBudget){
          await env.DB.prepare(`
            UPDATE shops SET budget_min=?,budget_max=?,updated_at=CURRENT_TIMESTAMP WHERE id=?
          `).bind(storedBudget.min,storedBudget.max,shop.id).run();
          updated.push({
            id:shop.id,name:shop.name,
            budget_min:storedBudget.min,budget_max:storedBudget.max,
            match_confidence:"none",match_score:0
          });
        }else{
          unchanged.push({id:shop.id,name:shop.name,reason:"MATCH_NOT_FOUND"});
        }
        await markOpenDataChecked(env,shop.id,"");
        continue;
      }

      const isGeo=found.kind==="geoapify";
      const isFsq=found.kind==="foursquare";
      const place=isGeo?found.feature:(isFsq?found.fsq_place:found.place);

      const address=isGeo?geoAddress(place):(isFsq?fsqAddress(place):osmAddress(place));
      const phone=isGeo?geoPhone(place):(isFsq?fsqPhone(place):osmPhone(place));
      const website=isGeo?geoWebsite(place):(isFsq?fsqWebsite(place):osmWebsite(place));
      const instagram=isGeo?geoInstagram(place):(isFsq?fsqInstagram(place):osmInstagram(place));
      const sourceHours=isGeo?geoHours(place):(isFsq?fsqHours(place):osmHours(place));
      const sourceHoliday=(isGeo||isFsq)?"":osmHoliday(place);
      const sourceFeatures=isGeo
        ? extractFeaturesInfo(`${geoCategories(place).join(" ")} ${geoName(place)}`)
        : isFsq
          ? extractFeaturesInfo(`${fsqCategories(place).join(" ")} ${fsqName(place)}`)
          : osmFeatures(place);

      const trusted=Number(found.score||0)>=90;
      let webMeta={ok:false,price:{min:null,max:null},hours:"",holiday:"",features:""};
      const needsWebPrice=storedBudget.invalid||!storedBudget.min||!storedBudget.max;
      if(website&&(revalidate||needsWebPrice||!shop.hours||!shop.holiday)){
        webMeta=await fetchOfficialWebsiteMetadata(website);
      }

      const sourcePrice=isGeo
        ? extractPriceInfo(JSON.stringify(geoFeatureProps(place)))
        : isFsq
          ? extractPriceInfo(JSON.stringify(place))
          : extractPublicMetadata(place);
      const sourceMin=(isGeo||isFsq)?sourcePrice.min:sourcePrice.budget_min;
      const sourceMax=(isGeo||isFsq)?sourcePrice.max:sourcePrice.budget_max;

      const extractedMin=webMeta.price?.min??sourceMin??null;
      const extractedMax=webMeta.price?.max??sourceMax??null;
      const inferredArea=inferKumamotoAreaFromText(address,shop.area||"");

      const next={
        area:trusted?(inferredArea||shop.area):shop.area,
        address:(trusted&&address)?address:(shop.address||""),
        phone:(trusted&&phone)?phone:(shop.phone||""),
        instagram:shop.instagram||instagram||"",
        hours:(trusted&&(sourceHours||webMeta.hours))
          ? (sourceHours||webMeta.hours)
          : (shop.hours||sourceHours||webMeta.hours||""),
        holiday:(trusted&&(sourceHoliday||webMeta.holiday))
          ? (sourceHoliday||webMeta.holiday)
          : (shop.holiday||sourceHoliday||webMeta.holiday||""),
        features:(trusted&&(sourceFeatures||webMeta.features))
          ? [sourceFeatures,webMeta.features].filter(Boolean).join("、")
          : (shop.features||sourceFeatures||webMeta.features||""),
        budget_min:extractedMin!=null?extractedMin:(storedBudget.min??null),
        budget_max:extractedMax!=null?extractedMax:(storedBudget.max??null)
      };

      if(next.budget_min&&next.budget_max&&next.budget_max<next.budget_min){
        [next.budget_min,next.budget_max]=[next.budget_max,next.budget_min];
      }

      const changed=
        String(next.area||"")!==String(shop.area||"")||
        String(next.address||"")!==String(shop.address||"")||
        String(next.phone||"")!==String(shop.phone||"")||
        String(next.instagram||"")!==String(shop.instagram||"")||
        String(next.hours||"")!==String(shop.hours||"")||
        String(next.holiday||"")!==String(shop.holiday||"")||
        String(next.features||"")!==String(shop.features||"")||
        Number(next.budget_min||0)!==Number(shop.budget_min||0)||
        Number(next.budget_max||0)!==Number(shop.budget_max||0);

      const sid=isGeo
        ? `geoapify/${String(geoFeatureProps(place).place_id||"")}`
        : isFsq
          ? `foursquare/${String(place.fsq_place_id||place.fsq_id||place.id||"")}`
          : `${place.type||""}/${place.id||""}`;
      await markOpenDataChecked(env,shop.id,sid);

      if(!changed){
        unchanged.push({id:shop.id,name:shop.name,reason:"NO_CHANGE"});
        continue;
      }

      await env.DB.prepare(`
        UPDATE shops SET
          area=?,address=?,phone=?,instagram=?,hours=?,holiday=?,features=?,
          budget_min=?,budget_max=?,updated_at=CURRENT_TIMESTAMP
        WHERE id=?
      `).bind(
        next.area,next.address,next.phone,next.instagram,next.hours,next.holiday,next.features,
        next.budget_min,next.budget_max,shop.id
      ).run();

      updated.push({
        id:shop.id,name:shop.name,
        area:next.area,address:next.address,phone:next.phone,
        hours:next.hours,holiday:next.holiday,
        budget_min:next.budget_min,budget_max:next.budget_max,
        match_confidence:found.confidence,
        match_score:found.score,
        source:found.source
      });
    }catch(e){
      failed.push({
        id:shop.id,name:shop.name,
        reason:String(e?.message||e||"UNKNOWN_ERROR").slice(0,300)
      });
    }
  }

  const nextAfterId=rows.length?Number(rows[rows.length-1].id||0):cursor;
  const moreR=await env.DB.prepare(`
    SELECT id FROM shops
    WHERE COALESCE(listing_status,'published')='provisional'
      AND id>?
    ORDER BY id ASC LIMIT 1
  `).bind(nextAfterId).first();

  return {
    ok:true,checked:rows.length,updated,unchanged,failed,
    next_after_id:nextAfterId,has_more:!!moreR,
    provider:"osm_geoapify"
  };
}


function foursquareConfig(env){
  return {apiKey:t(env.FOURSQUARE_API_KEY,2000)};
}

function fsqName(place){
  return String(place?.name||place?.display_name||"").trim();
}

function fsqCategories(place){
  const out=[];
  if(Array.isArray(place?.categories)){
    for(const c of place.categories){
      if(typeof c==="string")out.push(c);
      else if(c&&typeof c==="object"){
        out.push(c.name||c.short_name||c.label||c.category_name||"");
      }
    }
  }
  if(Array.isArray(place?.fsq_category_labels))out.push(...place.fsq_category_labels);
  if(Array.isArray(place?.category_labels))out.push(...place.category_labels);
  return [...new Set(out.map(x=>String(x||"").trim()).filter(Boolean))];
}

function fsqAddress(place){
  const l=place?.location||{};
  const parts=[
    place?.address||l.address,
    place?.address_extended||l.address_extended,
    place?.locality||l.locality,
    place?.region||l.region,
    place?.postcode||l.postcode
  ].filter(Boolean).map(String);
  const formatted=String(
    place?.formatted_address||
    l.formatted_address||
    l.formattedAddress||
    ""
  ).trim();
  return (formatted||parts.join(" ")).replace(/\s+/g," ").trim();
}

function fsqAreaHint(place){
  const l=place?.location||{};
  return String(place?.locality||l.locality||place?.region||l.region||"").trim();
}

function fsqPhone(place){
  return String(
    place?.tel||
    place?.telephone||
    place?.phone||
    place?.contact?.phone||
    ""
  ).trim();
}

function fsqWebsite(place){
  return String(
    place?.website||
    place?.website_url||
    place?.url||
    ""
  ).trim();
}

function fsqInstagram(place){
  const raw=String(
    place?.instagram||
    place?.social_media?.instagram||
    place?.social?.instagram||
    ""
  ).trim();
  const h=kbnHandle(raw||fsqWebsite(place));
  return h?`https://www.instagram.com/${h}/`:"";
}

function fsqHours(place){
  const h=place?.hours;
  if(!h)return "";
  if(typeof h==="string")return h.trim();
  if(Array.isArray(h))return h.map(String).join(" / ");
  if(Array.isArray(h?.display))return h.display.map(String).join(" / ");
  if(Array.isArray(h?.regular))return h.regular.map(x=>typeof x==="string"?x:JSON.stringify(x)).join(" / ");
  if(typeof h==="object"){
    const text=String(h.display||h.status||"").trim();
    if(text)return text;
  }
  return "";
}

function fsqLooksLikeBar(place){
  const cats=fsqCategories(place).join(" ").toLowerCase();
  const name=fsqName(place).toLowerCase();
  const strong=[
    "bar","pub","night club","nightclub","cocktail","lounge","snack",
    "バー","パブ","ナイトクラブ","カクテル","ラウンジ","スナック",
    "karaoke","カラオケ","darts","ダーツ","shisha","シーシャ"
  ];
  const bad=["restaurant","レストラン","cafe","カフェ","hotel","ホテル","美容","ネイル","病院"];
  return strong.some(x=>cats.includes(x)||name.includes(x))
    && !bad.some(x=>cats.includes(x) && !strong.some(y=>cats.includes(y)));
}

function fsqPlaceScore(place,{name="",area=""}={}){
  let score=placeNameMatchScore(name,fsqName(place));
  const addr=fsqAddress(place);
  const hint=fsqAreaHint(place);
  if(area&&(addr.includes(area)||hint.includes(area)))score+=18;
  else if(addr.includes("熊本")||hint.includes("熊本"))score+=8;
  if(fsqLooksLikeBar(place))score+=12;
  if(fsqPhone(place))score+=2;
  if(fsqWebsite(place))score+=2;
  return score;
}

async function foursquareSearch(env,{query="BAR",near="熊本県, 日本",limit=20}={}){
  const cfg=foursquareConfig(env);
  if(!cfg.apiKey){
    return {ok:false,configured:false,error:"FOURSQUARE_NOT_CONFIGURED",results:[]};
  }

  const u=new URL("https://places-api.foursquare.com/places/search");
  if(query)u.searchParams.set("query",String(query));
  if(near)u.searchParams.set("near",String(near));
  u.searchParams.set("limit",String(Math.max(1,Math.min(Number(limit)||20,50))));
  u.searchParams.set("sort","RELEVANCE");
  u.searchParams.set("tel_format","NATIONAL");

  try{
    const r=await fetch(u.toString(),{
      headers:{
        "Accept":"application/json",
        "Authorization":`Bearer ${cfg.apiKey}`,
        "X-Places-Api-Version":"2025-06-17"
      }
    });
    const text=await r.text();
    let d={};
    try{d=text?JSON.parse(text):{}}catch{d={raw:text}}
    if(!r.ok){
      return {
        ok:false,configured:true,
        error:d?.message||d?.error?.message||`FOURSQUARE_HTTP_${r.status}`,
        status:r.status,results:[]
      };
    }
    const results=Array.isArray(d?.results)
      ? d.results
      : Array.isArray(d?.places)
        ? d.places
        : [];
    return {ok:true,configured:true,results};
  }catch(e){
    return {
      ok:false,configured:true,
      error:String(e?.message||e||"FOURSQUARE_ERROR"),
      results:[]
    };
  }
}

async function findFoursquarePlaceForShop(env,{name,area}){
  const sr=await foursquareSearch(env,{
    query:String(name||"BAR"),
    near:[area,"熊本県","日本"].filter(Boolean).join(", "),
    limit:10
  });
  if(!sr.ok)return {ok:false,configured:!!sr.configured,error:sr.error,matched:false};

  const ranked=(sr.results||[])
    .filter(fsqLooksLikeBar)
    .map(place=>({place,score:fsqPlaceScore(place,{name,area})}))
    .sort((a,b)=>b.score-a.score);

  const best=ranked[0];
  if(!best||best.score<78){
    return {ok:true,configured:true,matched:false,score:best?.score||0};
  }
  return {
    ok:true,configured:true,matched:true,
    place:best.place,
    score:best.score,
    confidence:best.score>=100?"high":"medium",
    source:"foursquare"
  };
}

function crossSourceNameAreaScore(name,address,otherName,otherAddress){
  let score=placeNameMatchScore(name,otherName);
  const a1=inferKumamotoAreaFromText(address||"","");
  const a2=inferKumamotoAreaFromText(otherAddress||"","");
  if(a1&&a2&&a1===a2)score+=12;
  else if(address&&otherAddress&&String(otherAddress).includes("熊本"))score+=5;
  return score;
}

function normalizePhoneDigits(value){
  return String(value||"").replace(/\D/g,"");
}

function isLikelyJapanesePhone(value){
  const d=normalizePhoneDigits(value);
  return /^0\d{9,10}$/.test(d);
}

function isKumamotoAddress(value,area=""){
  const s=String(value||"").replace(/\s+/g,"");
  if(!s)return false;
  if(s.includes("熊本県"))return true;
  if(area && s.includes(String(area).replace(/\s+/g,"")))return true;
  return false;
}

function autoListingBarStrength({name="",genre="",categories=[],amenity=""}={}){
  const text=[name,genre,...categories,amenity].join(" ").toLowerCase();
  let score=0;

  const strong=[
    "bar","バー","pub","パブ","nightclub","night_club","ナイトクラブ",
    "snack","スナック","lounge","ラウンジ","darts","ダーツ",
    "karaoke","カラオケ","shisha","シーシャ","cocktail","カクテル"
  ];
  const bad=[
    "restaurant","レストラン","居酒屋","izakaya","cafe","カフェ",
    "hotel","ホテル","美容","ネイル","エステ","病院","歯科",
    "不動産","建設","学校","塾","コンビニ","スーパー"
  ];

  if(strong.some(x=>text.includes(x)))score+=3;
  if(/catering\.(bar|pub)/.test(text))score+=3;
  if(/^(bar|pub|nightclub|karaoke_box)$/.test(String(amenity||"")))score+=3;
  if(bad.some(x=>text.includes(x)))score-=5;

  return score;
}

function autoListingNameQuality(name){
  const s=String(name||"").trim();
  if(!s)return false;
  if(s.length<2 || s.length>80)return false;
  if(/^https?:\/\//i.test(s))return false;
  if(/^(bar|バー|pub|パブ|snack|スナック|lounge|ラウンジ)$/i.test(s))return false;
  if(/\b(?:求人|スタッフ募集|まとめ|ランキング|公式サイト)\b/i.test(s))return false;
  return true;
}

function autoListingContactScore({phone="",website="",instagram=""}={}){
  let score=0;
  if(isLikelyJapanesePhone(phone))score+=2;
  if(safeHttpUrl(website))score+=2;
  if(kbnHandle(instagram))score+=2;
  return score;
}

function autoListingDuplicateScore(existing,{name,address,phone,instagram}){
  const nkey=normalizePlaceName(name);
  const addressKey=String(address||"").replace(/\s+/g,"");
  const phoneKey=normalizePhoneDigits(phone);
  const igKey=kbnHandle(instagram);

  for(const x of existing){
    const sameName=nkey && normalizePlaceName(x.name)===nkey;
    const sameAddress=addressKey && x.address &&
      String(x.address).replace(/\s+/g,"")===addressKey;
    const samePhone=phoneKey && x.phone &&
      normalizePhoneDigits(x.phone)===phoneKey;
    const sameIg=igKey && x.instagram &&
      kbnHandle(x.instagram)===igKey;

    if(sameName||sameAddress||samePhone||sameIg)return true;
  }
  return false;
}

function strictAutoListingGate({
  name,area,address,genre,categories=[],amenity="",
  phone,website,instagram,
  sourceMatchScore=0,
  sourceCount=1
}={}){
  const reasons=[];
  let confidence=0;

  if(!autoListingNameQuality(name))reasons.push("NAME_WEAK");
  else confidence+=2;

  if(!isKumamotoAddress(address,area))reasons.push("ADDRESS_NOT_CONFIRMED");
  else confidence+=3;

  const barStrength=autoListingBarStrength({name,genre,categories,amenity});
  if(barStrength<3)reasons.push("BAR_CATEGORY_WEAK");
  else confidence+=Math.min(4,barStrength);

  const contactScore=autoListingContactScore({phone,website,instagram});
  if(contactScore<2)reasons.push("NO_RELIABLE_CONTACT");
  else confidence+=Math.min(4,contactScore);

  if(Number(sourceMatchScore||0)>=90)confidence+=3;
  else if(Number(sourceMatchScore||0)>=80)confidence+=1;
  else if(sourceCount<=1)reasons.push("SOURCE_MATCH_WEAK");

  if(sourceCount>=2)confidence+=3;

  // Strict threshold: missing any core requirement blocks auto-listing.
  const coreBlocked=reasons.some(r=>
    ["NAME_WEAK","ADDRESS_NOT_CONFIRMED","BAR_CATEGORY_WEAK","NO_RELIABLE_CONTACT"].includes(r)
  );

  const approved=!coreBlocked && confidence>=10;

  return {
    approved,
    confidence,
    reasons,
    bar_strength:barStrength,
    contact_score:contactScore
  };
}

async function autoDiscover(env,request,maxListings=10,pairLimit=6,perPairLimit=2){
  await ensureLeadDiscoveryTables(env);

  const osmSnap=await fetchKumamotoOsmBars(env);
  const geoSnap=await fetchKumamotoGeoapifyBars(env);
  const fsqConfigured=!!foursquareConfig(env).apiKey;

  if(!osmSnap.ok && !geoSnap.ok && !fsqConfigured){
    return {
      ok:false,
      error:osmSnap.error||geoSnap.error||"DISCOVERY_SOURCES_UNAVAILABLE",
      created:[],searched:[],rejected:[]
    };
  }

  const pairs=await autoDiscoveryPairs(env,pairLimit);
  const created=[],searched=[],rejected=[];
  const existingR=await env.DB.prepare(
    "SELECT id,name,address,phone,instagram FROM shops"
  ).all();
  const existing=existingR.results||[];

  for(const pair of pairs){
    if(created.length>=maxListings)break;

    // Foursquare is the primary discovery source. One call per area/type pair.
    let fsqSearch={ok:false,configured:fsqConfigured,results:[],error:"FOURSQUARE_NOT_CONFIGURED"};
    if(fsqConfigured){
      fsqSearch=await foursquareSearch(env,{
        query:pair.label||"BAR",
        near:[pair.area,"熊本県","日本"].filter(Boolean).join(", "),
        limit:20
      });
    }

    const fsqCandidates=fsqSearch.ok
      ? fsqSearch.results.filter(fsqLooksLikeBar).map(place=>({kind:"foursquare",place}))
      : [];

    const osmCandidates=osmSnap.ok
      ? osmSnap.places.filter(place=>{
          const addr=osmAddress(place);
          const areaHint=osmAreaHint(place);
          return (!pair.area||addr.includes(pair.area)||areaHint.includes(pair.area))
            && osmPlaceLooksLikeBar(place);
        }).map(place=>({kind:"osm",place}))
      : [];

    const geoCandidates=geoSnap.ok
      ? geoSnap.features.filter(feature=>{
          const addr=geoAddress(feature);
          const areaHint=geoAreaHint(feature);
          return (!pair.area||addr.includes(pair.area)||areaHint.includes(pair.area))
            && geoLooksLikeBar(feature);
        }).map(feature=>({kind:"geoapify",place:feature}))
      : [];

    // When Foursquare is available it leads the list; OSM/Geoapify supplement it.
    const candidates=fsqCandidates.length
      ? [...fsqCandidates,...geoCandidates,...osmCandidates]
      : [...geoCandidates,...osmCandidates];

    searched.push({
      area:pair.area,
      type:pair.label,
      ok:true,
      found:candidates.length,
      source:[
        fsqSearch.ok?"foursquare":"",
        geoSnap.ok?geoSnap.source:"",
        osmSnap.ok?osmSnap.source:""
      ].filter(Boolean).join("+"),
      foursquare_error:fsqSearch.ok?"":(fsqSearch.error||"")
    });

    await env.DB.prepare(
      "INSERT INTO lead_discovery_runs(area,lead_type,searched_at) VALUES(?,?,CURRENT_TIMESTAMP)"
    ).bind(pair.area,pair.type).run();

    let made=0;
    const seenCandidateNames=new Set();

    for(const item of candidates){
      if(made>=perPairLimit||created.length>=maxListings)break;

      const isFsq=item.kind==="foursquare";
      const isGeo=item.kind==="geoapify";
      let place=item.place;

      const name=t(
        isFsq?fsqName(place):(isGeo?geoName(place):osmPlaceName(place)),
        150
      );
      if(!name)continue;

      const nkey=normalizePlaceName(name);
      if(seenCandidateNames.has(nkey))continue;
      seenCandidateNames.add(nkey);

      if(isGeo){
        const pid=geoFeatureProps(place).place_id||"";
        if(pid){
          const detail=await geoapifyPlaceDetails(env,pid);
          if(detail.ok&&detail.feature)place=detail.feature;
        }
      }

      const address=t(
        isFsq?fsqAddress(place):(isGeo?geoAddress(place):osmAddress(place)),
        500
      );
      const phone=t(
        isFsq?fsqPhone(place):(isGeo?geoPhone(place):osmPhone(place)),
        80
      );
      const website=isFsq?fsqWebsite(place):(isGeo?geoWebsite(place):osmWebsite(place));
      const instagram=isFsq?fsqInstagram(place):(isGeo?geoInstagram(place):osmInstagram(place));

      const sourceHours=isFsq?fsqHours(place):(isGeo?geoHours(place):osmHours(place));
      const sourceHoliday=(isFsq||isGeo)?"":osmHoliday(place);
      const categories=isFsq?fsqCategories(place):(isGeo?geoCategories(place):[]);
      const amenity=(isFsq||isGeo)?"":String(osmTags(place).amenity||"");
      const sourceFeatures=isFsq
        ? extractFeaturesInfo(`${categories.join(" ")} ${name}`)
        : isGeo
          ? extractFeaturesInfo(`${categories.join(" ")} ${name}`)
          : osmFeatures(place);

      // Cross-check the same place in all other available sources.
      let sourceCount=1;
      let bestCrossScore=0;

      if(!isFsq && fsqSearch.ok){
        const other=fsqSearch.results
          .map(p=>({
            p,
            score:crossSourceNameAreaScore(name,address,fsqName(p),fsqAddress(p))
          }))
          .sort((a,b)=>b.score-a.score)[0];
        if(other&&other.score>=82){
          sourceCount++;
          bestCrossScore=Math.max(bestCrossScore,other.score);
        }
      }

      if(!isGeo && geoSnap.ok){
        const other=geoSnap.features
          .map(f=>({
            f,
            score:crossSourceNameAreaScore(name,address,geoName(f),geoAddress(f))
          }))
          .sort((a,b)=>b.score-a.score)[0];
        if(other&&other.score>=82){
          sourceCount++;
          bestCrossScore=Math.max(bestCrossScore,other.score);
        }
      }

      if(item.kind!=="osm" && osmSnap.ok){
        const other=osmSnap.places
          .map(p=>({
            p,
            score:crossSourceNameAreaScore(name,address,osmPlaceName(p),osmAddress(p))
          }))
          .sort((a,b)=>b.score-a.score)[0];
        if(other&&other.score>=82){
          sourceCount++;
          bestCrossScore=Math.max(bestCrossScore,other.score);
        }
      }

      if(autoListingDuplicateScore(existing,{name,address,phone,instagram})){
        rejected.push({name,area:pair.area,reason:"DUPLICATE"});
        continue;
      }

      const genre=t(
        isFsq
          ? (
              categories.some(x=>/pub|パブ/i.test(x))?"パブ":
              categories.some(x=>/night.?club|ナイトクラブ/i.test(x))?"ナイトクラブ":
              categories.some(x=>/karaoke|カラオケ/i.test(x))?"カラオケBAR":"BAR"
            )
          : isGeo
            ? (categories.some(x=>x==="catering.pub")?"パブ":"BAR")
            : (amenity==="karaoke_box"?"カラオケBAR":
               amenity==="pub"?"パブ":
               amenity==="nightclub"?"ナイトクラブ":"BAR"),
        120
      );

      const gate=strictAutoListingGate({
        name,
        area:pair.area,
        address,
        genre,
        categories,
        amenity,
        phone,
        website,
        instagram,
        sourceMatchScore:bestCrossScore,
        sourceCount
      });

      // Foursquare + at least one other matching source receives a small
      // confidence advantage, but core safety requirements still apply.
      if(isFsq&&sourceCount>=2){
        gate.confidence+=2;
        if(!gate.approved){
          const coreBlocked=gate.reasons.some(r=>
            ["NAME_WEAK","ADDRESS_NOT_CONFIRMED","BAR_CATEGORY_WEAK","NO_RELIABLE_CONTACT"].includes(r)
          );
          gate.approved=!coreBlocked&&gate.confidence>=10;
        }
      }

      if(!gate.approved){
        rejected.push({
          name,area:pair.area,
          reason:gate.reasons.join(",")||"LOW_CONFIDENCE",
          confidence:gate.confidence,
          source:item.kind,
          source_count:sourceCount
        });
        continue;
      }

      const webMeta=website?await fetchOfficialWebsiteMetadata(website):
        {ok:false,price:{min:null,max:null},hours:"",holiday:"",features:""};

      const sourcePrice=isFsq
        ? extractPriceInfo(JSON.stringify(place))
        : isGeo
          ? extractPriceInfo(JSON.stringify(geoFeatureProps(place)))
          : extractPublicMetadata(place);

      const sourceMin=(isFsq||isGeo)?sourcePrice.min:sourcePrice.budget_min;
      const sourceMax=(isFsq||isGeo)?sourcePrice.max:sourcePrice.budget_max;

      const area=inferKumamotoAreaFromText(address,pair.area);
      const hours=sourceHours||webMeta.hours||"";
      const holiday=sourceHoliday||webMeta.holiday||"";
      const features=[sourceFeatures,webMeta.features].filter(Boolean).join("、");
      const budgetMin=webMeta.price?.min??sourceMin??null;
      const budgetMax=webMeta.price?.max??sourceMax??null;

      const desc=
        "※本ページは、公開されている情報をもとにKUMAMOTO BAR NAVIが独自に掲載しています。"+
        "掲載内容の修正・削除をご希望の場合は店舗様専用ページよりご連絡ください。";

      const slug=slugify(name);
      const ins=await env.DB.prepare(`
        INSERT INTO shops(
          slug,name,name_kana,area,address,hours,holiday,instagram,genre,features,description,
          budget_min,budget_max,seats,phone,is_recruiting,is_published,image_url,image_key,
          is_featured,is_new,sort_order,listing_status,published_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'provisional',CURRENT_TIMESTAMP)
      `).bind(
        slug,name,"",area,address,hours,holiday,instagram,
        genre,features,desc,budgetMin,budgetMax,null,phone,
        0,1,"","",0,1,100
      ).run();

      const id=Number(ins.meta?.last_row_id||0);
      const token=ownerToken(),hash=await sha256hex(token);
      await env.DB.prepare(
        "UPDATE shops SET owner_token_hash=?,owner_token_created_at=CURRENT_TIMESTAMP WHERE id=?"
      ).bind(hash,id).run();

      const sid=isFsq
        ? `foursquare/${String(place.fsq_place_id||place.fsq_id||place.id||id)}`
        : isGeo
          ? `geoapify/${String(geoFeatureProps(place).place_id||id)}`
          : `${place.type||""}/${place.id||""}`;
      await markOpenDataChecked(env,id,sid);

      await env.DB.prepare(`
        INSERT OR IGNORE INTO lead_discovery_seen(instagram_handle,source_area,source_type,status)
        VALUES(?,?,?,'provisional_listed')
      `).bind(
        `${item.kind}_${String(
          isFsq?(place.fsq_place_id||place.fsq_id||place.id||id):
          isGeo?(geoFeatureProps(place).place_id||id):(place.id||id)
        )}`,
        area,pair.type
      ).run();

      existing.push({id,name,address,phone,instagram});

      const origin=new URL(request.url).origin;
      created.push({
        shop_id:id,
        name,
        handle:kbnHandle(instagram),
        area,
        genre,
        address,
        phone,
        hours,
        holiday,
        budget_min:budgetMin,
        budget_max:budgetMax,
        auto_confidence:gate.confidence,
        source_count:sourceCount,
        source:item.kind,
        public_url:`${origin}/shop.html?slug=${encodeURIComponent(slug)}`
      });
      made++;
    }
  }

  return {
    ok:true,
    created,
    searched,
    rejected:rejected.slice(0,50),
    rejected_count:rejected.length,
    provider:fsqConfigured?"foursquare_geoapify_osm":"geoapify_osm",
    foursquare_configured:fsqConfigured,
    geoapify_configured:!!geoSnap.configured
  };
}
async function ensureListingStatusColumn(env){
  if(!env.DB)return;
  try{
    const info=await env.DB.prepare("PRAGMA table_info(shops)").all();
    const cols=(info.results||[]).map(x=>String(x.name||""));
    if(!cols.includes("listing_status")){
      await env.DB.prepare(
        "ALTER TABLE shops ADD COLUMN listing_status TEXT NOT NULL DEFAULT 'published'"
      ).run();
    }
  }catch(e){
    console.error("ensureListingStatusColumn failed",e);
  }
}

function normalizeListingStatus(v){
  return String(v||"published")==="provisional"?"provisional":"published";
}

function publicShopRow(s){
  if(!s)return s;
  const provisional=normalizeListingStatus(s.listing_status)==="provisional";
  return {
    ...s,
    listing_status:provisional?"provisional":"published",
    is_provisional:provisional?1:0,
    name:provisional?`【KBN独自掲載】${s.name}`:s.name
  };
}

function shopPayload(x){
  return {
    slug: slugify(x.slug||x.name),
    name:t(x.name,150), name_kana:t(x.name_kana,150), area:t(x.area,80),
    address:t(x.address,300), hours:t(x.hours,150), holiday:t(x.holiday,120),
    instagram:t(x.instagram,500), genre:t(x.genre,120), features:t(x.features,1000),
    description:t(x.description,5000), budget_min:ni(x.budget_min), budget_max:ni(x.budget_max),
    seats:ni(x.seats), phone:t(x.phone,80), is_recruiting:b(x.is_recruiting),
    is_published:x.is_published===false||x.is_published===0?0:1,
    image_url:t(x.image_url,1000), image_key:t(x.image_key,500),
    is_featured:b(x.is_featured), is_new:x.is_new===false||x.is_new===0?0:1,
    sort_order:ni(x.sort_order)??100,
    listing_status:normalizeListingStatus(x.listing_status)
  };
}


const LOGIN_HTML="<!doctype html>\n<html lang=\"ja\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">\n<title>KBN ADMIN LOGIN</title>\n<style>\n:root{color-scheme:dark}\n*{box-sizing:border-box}\nbody{margin:0;min-height:100vh;display:grid;place-items:center;background:#080d13;color:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,\"Hiragino Sans\",\"Yu Gothic\",sans-serif;padding:22px}\n.card{width:min(440px,100%);padding:28px;border:1px solid #36404c;border-radius:20px;background:#101720;box-shadow:0 20px 70px rgba(0,0,0,.35)}\n.eyebrow{color:#e8be55;letter-spacing:.18em;font-weight:800;font-size:.78rem}\nh1{font-size:2rem;margin:.35rem 0 .7rem}\np{color:#aeb5bf;line-height:1.7}\nlabel{display:block;margin:18px 0 7px;color:#d9dde2;font-weight:700}\ninput{width:100%;min-height:52px;padding:0 14px;border-radius:12px;border:1px solid #3b4653;background:#0a1017;color:#fff;font-size:1rem}\nbutton{width:100%;min-height:54px;margin-top:20px;border:0;border-radius:12px;background:#efc45a;color:#111;font-weight:900;font-size:1rem}\n#error{color:#ff9a9a;min-height:1.4em;margin-top:12px}\n.note{font-size:.78rem;margin-top:16px}\n</style>\n</head>\n<body>\n<form class=\"card\" id=\"loginForm\">\n  <div class=\"eyebrow\">KBN ADMIN ver1.13</div>\n  <h1>運営管理ログイン</h1>\n  <p>管理者用のメールアドレスとパスワードを入力してください。</p>\n  <label for=\"email\">メールアドレス</label>\n  <input id=\"email\" type=\"email\" autocomplete=\"username\" required>\n  <label for=\"password\">パスワード</label>\n  <input id=\"password\" type=\"password\" autocomplete=\"current-password\" required>\n  <button type=\"submit\">ログイン</button>\n  <div id=\"error\"></div>\n  <p class=\"note\">この端末では30日間ログイン状態を保持します。</p>\n</form>\n\n<script>\nconst form=document.getElementById(\"loginForm\");\nconst error=document.getElementById(\"error\");\n\nform.addEventListener(\"submit\",async ev=>{\n  ev.preventDefault();\n  error.textContent=\"ログイン中...\";\n\n  const email=document.getElementById(\"email\").value.trim();\n  const password=document.getElementById(\"password\").value;\n\n  try{\n    const r=await fetch(\"/api/admin/login\",{\n      method:\"POST\",\n      credentials:\"include\",\n      cache:\"no-store\",\n      headers:{\"Content-Type\":\"application/json\"},\n      body:JSON.stringify({email,password})\n    });\n\n    const ct=r.headers.get(\"content-type\")||\"\";\n    if(!ct.includes(\"application/json\")){\n      const text=await r.text();\n      throw new Error(\"NON_JSON_RESPONSE: \"+text.slice(0,80));\n    }\n\n    const d=await r.json();\n\n    if(!r.ok || !d.ok){\n      if(d.error===\"INVALID_CREDENTIALS\"){\n        throw new Error(\"INVALID_CREDENTIALS\");\n      }\n      if(d.error===\"ADMIN_AUTH_NOT_CONFIGURED\"){\n        throw new Error(\"設定不足: \"+(d.missing||[]).join(\", \"));\n      }\n      throw new Error(d.message||d.error||(\"HTTP_\"+r.status));\n    }\n\n    if(!d.token){\n      throw new Error(\"TOKEN_NOT_RETURNED\");\n    }\n\n    localStorage.setItem(\"kbn_admin_token\",d.token);\n    localStorage.setItem(\"kbn_admin_logged_in_at\",String(Date.now()));\n\n    location.replace(\"/admin.html?v=113\");\n  }catch(err){\n    console.error(err);\n\n    if(err.message===\"INVALID_CREDENTIALS\"){\n      error.textContent=\"メールアドレスまたはパスワードが違います。\";\n    }else{\n      error.textContent=\"ログインできませんでした: \"+err.message;\n    }\n  }\n});\n</script>\n\n</body></html>";
const ADMIN_COOKIE="kbn_admin_session";
const ADMIN_SESSION_DAYS=30;

async function authHmac(secret,message){
  const enc=new TextEncoder();
  const key=await crypto.subtle.importKey("raw",enc.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const sig=await crypto.subtle.sign("HMAC",key,enc.encode(message));
  return [...new Uint8Array(sig)].map(b=>b.toString(16).padStart(2,"0")).join("");
}
function authCookie(request,name){
  const raw=request.headers.get("Cookie")||"";
  for(const part of raw.split(";")){
    const [k,...rest]=part.trim().split("=");
    if(k===name)return decodeURIComponent(rest.join("="));
  }
  return "";
}
function authEqual(a,b){
  a=String(a??"");b=String(b??"");
  if(a.length!==b.length)return false;
  let x=0;for(let i=0;i<a.length;i++)x|=a.charCodeAt(i)^b.charCodeAt(i);
  return x===0;
}

function adminBearer(request){
  const h=request.headers.get("Authorization")||"";
  const m=h.match(/^Bearer\s+(.+)$/i);
  return m?m[1].trim():"";
}
async function validAdminToken(token,env){
  try{
    if(!env.ADMIN_SESSION_SECRET||!token)return false;
    const p=String(token).split(".");
    if(p.length!==3||p[0]!=="admin")return false;
    const exp=Number(p[1]);
    if(!Number.isFinite(exp)||exp<Date.now())return false;
    const expected=await authHmac(env.ADMIN_SESSION_SECRET,`admin.${exp}`);
    return authEqual(p[2],expected);
  }catch{return false}
}
async function validAdminRequest(request,env){
  const bearer=adminBearer(request);
  if(bearer && await validAdminToken(bearer,env))return true;
  return await validAdminSession(request,env);
}

async function makeAdminSession(env){
  const exp=Date.now()+ADMIN_SESSION_DAYS*86400000;
  const payload=`admin.${exp}`;
  const sig=await authHmac(env.ADMIN_SESSION_SECRET,payload);
  return `${payload}.${sig}`;
}
async function validAdminSession(request,env){
  try{
    if(!env.ADMIN_SESSION_SECRET)return false;
    const token=authCookie(request,ADMIN_COOKIE);
    const p=token.split(".");
    if(p.length!==3||p[0]!=="admin")return false;
    const exp=Number(p[1]);if(!Number.isFinite(exp)||exp<Date.now())return false;
    const expected=await authHmac(env.ADMIN_SESSION_SECRET,`admin.${exp}`);
    return authEqual(p[2],expected);
  }catch{return false}
}
function setAdminCookie(token){
  return `${ADMIN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${ADMIN_SESSION_DAYS*86400}`;
}
function clearAdminCookie(){
  return `${ADMIN_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}


const KBN_LOCAL_SEO_AREAS={
  "kumamoto-city":"熊本市",
  "yatsushiro":"八代市",
  "hitoyoshi":"人吉市",
  "arao":"荒尾市",
  "minamata":"水俣市",
  "tamana":"玉名市",
  "yamaga":"山鹿市",
  "kikuchi":"菊池市",
  "uto":"宇土市",
  "kamiamakusa":"上天草市",
  "uki":"宇城市",
  "aso":"阿蘇市",
  "amakusa":"天草市",
  "koshi":"合志市",
  "misato":"美里町",
  "gyokuto":"玉東町",
  "nankan":"南関町",
  "nagasu":"長洲町",
  "nagomi":"和水町",
  "ozu":"大津町",
  "kikuyo":"菊陽町",
  "minamioguni":"南小国町",
  "oguni":"小国町",
  "ubuyama":"産山村",
  "takamori":"高森町",
  "nishihara":"西原村",
  "minamiaso":"南阿蘇村",
  "mifune":"御船町",
  "kashima":"嘉島町",
  "mashiki":"益城町",
  "kosa":"甲佐町",
  "yamato":"山都町",
  "hikawa":"氷川町",
  "ashikita":"芦北町",
  "tsunagi":"津奈木町",
  "nishiki":"錦町",
  "taragi":"多良木町",
  "yunomae":"湯前町",
  "mizukami":"水上村",
  "sagara":"相良村",
  "itsuki":"五木村",
  "yamae":"山江村",
  "kuma":"球磨村",
  "asagiri":"あさぎり町",
  "reihoku":"苓北町"
};

function kbnSeoEsc(v){
  return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function kbnCleanShopName(v){
  return String(v||"").replace(/^【KBN独自掲載】/,"")
    .replace(/\s*[（(]\s*@[A-Za-z0-9._]+\s*[）)]\s*$/,"")
    .replace(/\s+@[A-Za-z0-9._]+\s*$/,"").trim();
}
function kbnBudget(s){
  const a=Number(s?.budget_min||0), b=Number(s?.budget_max||0);
  if(a&&b)return `¥${a.toLocaleString()}〜¥${b.toLocaleString()}`;
  if(a)return `¥${a.toLocaleString()}〜`;
  if(b)return `〜¥${b.toLocaleString()}`;
  return "";
}
async function renderLocalSeoAreaPage(env,slug){
  const area=KBN_LOCAL_SEO_AREAS[slug];
  if(!area)return null;
  let shops=[];
  try{
    const r=await env.DB.prepare(`
      SELECT slug,name,area,address,hours,genre,features,budget_min,budget_max,image_url,listing_status,is_recruiting
      FROM shops
      WHERE is_published=1 AND area=?
      ORDER BY COALESCE(is_featured,0) DESC, COALESCE(sort_order,100) ASC, updated_at DESC
      LIMIT 100
    `).bind(area).all();
    shops=r.results||[];
  }catch(e){ console.error("local seo area query",e); }

  const canonical=`https://kumamoto-bar-navi.rrwpvwmz8p.workers.dev/area/${slug}`;
  const title=`${area}のBAR・バー一覧｜料金・営業時間・求人情報｜KUMAMOTO BAR NAVI`;
  const description=`${area}のBAR・バーを探すならKUMAMOTO BAR NAVI。${shops.length?`現在${shops.length}店舗を掲載。`:""}料金、営業時間、ジャンル、特徴、求人情報を確認できます。`;

  const cards=shops.map(s=>{
    const name=kbnCleanShopName(s.name)||"BAR";
    const budget=kbnBudget(s);
    return `<article class="local-seo-card">
      <a href="/shop.html?slug=${encodeURIComponent(s.slug||"")}">
        <div class="local-seo-img">${s.image_url?`<img src="${kbnSeoEsc(s.image_url)}" alt="${kbnSeoEsc(name)} ${kbnSeoEsc(area)} BAR" loading="lazy">`:`<img src="/default-bar.svg" alt="" loading="lazy">`}</div>
        <div class="local-seo-body">
          <div class="local-seo-meta"><span>${kbnSeoEsc(s.genre||"BAR")}</span>${s.listing_status==="provisional"?"<small>KBN独自掲載</small>":""}</div>
          <h2>${kbnSeoEsc(name)}</h2>
          ${s.address?`<p>${kbnSeoEsc(s.address)}</p>`:""}
          <div class="local-seo-facts">
            ${s.hours?`<span><small>営業時間</small><b>${kbnSeoEsc(s.hours)}</b></span>`:""}
            ${budget?`<span><small>料金目安</small><b>${kbnSeoEsc(budget)}</b></span>`:""}
          </div>
          <div class="local-seo-bottom">${s.is_recruiting?`<em>求人あり</em>`:""}<b>店舗詳細を見る →</b></div>
        </div>
      </a>
    </article>`;
  }).join("");

  const faq=[
    [`${area}のBARはどうやって探せますか？`,`このページで${area}に掲載されているBARを一覧で確認できます。`],
    [`${area}のBARの料金や営業時間は確認できますか？`,`各店舗ページで公開されている料金目安、営業時間、住所などを掲載しています。`],
    [`${area}のBAR求人も探せますか？`,`求人情報が登録されている店舗はKUMAMOTO BAR NAVIの求人ページから確認できます。`]
  ];
  const itemList=shops.slice(0,50).map((s,i)=>({"@type":"ListItem","position":i+1,"name":kbnCleanShopName(s.name),"url":`https://kumamoto-bar-navi.rrwpvwmz8p.workers.dev/shop.html?slug=${encodeURIComponent(s.slug||"")}`}));
  const jsonLd={"@context":"https://schema.org","@graph":[
    {"@type":"CollectionPage","name":`${area}のBAR・バー一覧`,"url":canonical,"description":description},
    {"@type":"ItemList","name":`${area}のBAR一覧`,"numberOfItems":shops.length,"itemListElement":itemList},
    {"@type":"FAQPage","mainEntity":faq.map(x=>({"@type":"Question","name":x[0],"acceptedAnswer":{"@type":"Answer","text":x[1]}}))}
  ]};

  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${kbnSeoEsc(title)}</title><meta name="description" content="${kbnSeoEsc(description)}"><link rel="canonical" href="${canonical}">
<meta property="og:type" content="website"><meta property="og:title" content="${kbnSeoEsc(title)}"><meta property="og:description" content="${kbnSeoEsc(description)}"><meta property="og:url" content="${canonical}">
<meta name="robots" content="index,follow,max-image-preview:large"><link rel="stylesheet" href="/style.css?v=118">
<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g,"\\u003c")}</script></head>
<body class="public-v109 local-seo-page">
<header class="public-header"><div class="container public-header-inner"><a class="public-brand" href="/"><img src="/logo.png" alt="KUMAMOTO BAR NAVI"><span><b>KUMAMOTO</b><strong>BAR NAVI</strong><small>BAR & JOB INFORMATION</small></span></a><nav class="public-desktop-nav"><a href="/bars.html">BARを探す</a><a href="/areas.html" class="active">エリア</a><a href="/jobs.html">求人</a><a href="/column.html">コラム</a></nav><a class="public-header-cta" href="/bars.html">BARを探す</a></div></header>
<main><section class="local-seo-hero"><div class="container"><nav class="local-seo-breadcrumb"><a href="/">ホーム</a><span>›</span><a href="/areas.html">エリア</a><span>›</span><b>${kbnSeoEsc(area)}</b></nav><p class="public-kicker">KUMAMOTO AREA GUIDE</p><h1>${kbnSeoEsc(area)}のBAR・バー</h1><p>${kbnSeoEsc(area)}で今夜行きたいBARを探せます。営業時間・料金・ジャンルを比較して自分に合う一軒を見つけてください。</p><div class="local-seo-count"><strong>${shops.length}</strong><span>店舗掲載中</span></div></div></section>
<section class="local-seo-list"><div class="container"><div class="local-seo-head"><div><p class="public-kicker">BAR LIST</p><h2>${kbnSeoEsc(area)}のBAR一覧</h2></div><a href="/bars.html?area=${encodeURIComponent(area)}">絞り込み検索 →</a></div>${shops.length?`<div class="local-seo-grid">${cards}</div>`:`<div class="local-seo-empty"><h2>${kbnSeoEsc(area)}の掲載店舗を準備中です</h2><p>店舗情報を順次追加しています。</p></div>`}</div></section>
<section class="local-seo-guide"><div class="container"><p class="public-kicker">AREA GUIDE</p><h2>${kbnSeoEsc(area)}でBARを探す</h2><p>${kbnSeoEsc(area)}のBAR選びでは、営業時間や料金だけでなく、ダーツ・カラオケ・ワイン・シーシャなど店舗ごとの特徴を比べるのがおすすめです。</p></div></section>
<section class="local-seo-faq"><div class="container"><p class="public-kicker">FAQ</p><h2>${kbnSeoEsc(area)}のBAR探し よくある質問</h2><div>${faq.map(x=>`<details><summary>${kbnSeoEsc(x[0])}</summary><p>${kbnSeoEsc(x[1])}</p></details>`).join("")}</div></div></section>
</main><nav class="public-bottom-nav"><a href="/"><span>⌂</span><b>ホーム</b></a><a href="/bars.html"><span>⌕</span><b>BARを探す</b></a><a href="/jobs.html"><span>▣</span><b>求人</b></a><a href="/listing-form.html"><span>＋</span><b>店舗掲載</b></a></nav></body></html>`;
}

export default {
  async fetch(request, env, ctx) {
    const url=new URL(request.url);

    const localSeoAreaMatch=url.pathname.match(/^\/area\/([a-z0-9-]+)\/?$/);
    if(localSeoAreaMatch && request.method==="GET"){
      const html=await renderLocalSeoAreaPage(env,localSeoAreaMatch[1]);
      if(!html)return new Response("Not Found",{status:404});
      return new Response(html,{headers:{"content-type":"text/html; charset=utf-8","cache-control":"public, max-age=900"}});
    }


    // ---------- SEO endpoints ----------
    if(url.pathname==="/robots.txt" && request.method==="GET"){
      const body=[
        "User-agent: *",
        "Allow: /",
        "Disallow: /admin",
        "Disallow: /admin-login",
        "Disallow: /owner.html",
        "Disallow: /owner-portal.html",
        "Disallow: /db-status.html",
        "",
        "Sitemap: https://kumamoto-bar-navi.rrwpvwmz8p.workers.dev/sitemap.xml"
      ].join("\n");

      return new Response(body,{
        headers:{
          "content-type":"text/plain; charset=utf-8",
          "cache-control":"public, max-age=3600"
        }
      });
    }

    if(url.pathname==="/sitemap.xml" && request.method==="GET"){
      const base="https://kumamoto-bar-navi.rrwpvwmz8p.workers.dev";
      const urls=[
        {loc:`${base}/`,priority:"1.0",freq:"daily"},
        {loc:`${base}/bars.html`,priority:"0.9",freq:"daily"},
        {loc:`${base}/jobs.html`,priority:"0.8",freq:"daily"},
        {loc:`${base}/column.html`,priority:"0.6",freq:"weekly"},
        {loc:`${base}/areas.html`,priority:"0.8",freq:"weekly"},
        {loc:`${base}/area/kumamoto-city`,priority:"0.8",freq:"daily"},
        {loc:`${base}/area/yatsushiro`,priority:"0.8",freq:"daily"},
        {loc:`${base}/area/hitoyoshi`,priority:"0.8",freq:"daily"},
        {loc:`${base}/area/arao`,priority:"0.8",freq:"daily"},
        {loc:`${base}/area/minamata`,priority:"0.8",freq:"daily"},
        {loc:`${base}/area/tamana`,priority:"0.8",freq:"daily"},
        {loc:`${base}/area/yamaga`,priority:"0.8",freq:"daily"},
        {loc:`${base}/area/kikuchi`,priority:"0.8",freq:"daily"},
        {loc:`${base}/area/uto`,priority:"0.8",freq:"daily"},
        {loc:`${base}/area/kamiamakusa`,priority:"0.8",freq:"daily"},
        {loc:`${base}/area/uki`,priority:"0.8",freq:"daily"},
        {loc:`${base}/area/aso`,priority:"0.8",freq:"daily"},
        {loc:`${base}/area/amakusa`,priority:"0.8",freq:"daily"},
        {loc:`${base}/area/koshi`,priority:"0.8",freq:"daily"},
        {loc:`${base}/area/misato`,priority:"0.8",freq:"daily"},
        {loc:`${base}/area/gyokuto`,priority:"0.8",freq:"daily"},
        {loc:`${base}/area/nankan`,priority:"0.8",freq:"daily"},
        {loc:`${base}/area/nagasu`,priority:"0.8",freq:"daily"},
        {loc:`${base}/area/nagomi`,priority:"0.8",freq:"daily"},
        {loc:`${base}/area/ozu`,priority:"0.8",freq:"daily"},
        {loc:`${base}/area/kikuyo`,priority:"0.8",freq:"daily"},
        {loc:`${base}/area/minamioguni`,priority:"0.8",freq:"daily"},
        {loc:`${base}/area/oguni`,priority:"0.8",freq:"daily"},
        {loc:`${base}/area/ubuyama`,priority:"0.8",freq:"daily"},
        {loc:`${base}/area/takamori`,priority:"0.8",freq:"daily"},
        {loc:`${base}/area/nishihara`,priority:"0.8",freq:"daily"},
        {loc:`${base}/area/minamiaso`,priority:"0.8",freq:"daily"},
        {loc:`${base}/area/mifune`,priority:"0.8",freq:"daily"},
        {loc:`${base}/area/kashima`,priority:"0.8",freq:"daily"},
        {loc:`${base}/area/mashiki`,priority:"0.8",freq:"daily"},
        {loc:`${base}/area/kosa`,priority:"0.8",freq:"daily"},
        {loc:`${base}/area/yamato`,priority:"0.8",freq:"daily"},
        {loc:`${base}/area/hikawa`,priority:"0.8",freq:"daily"},
        {loc:`${base}/area/ashikita`,priority:"0.8",freq:"daily"},
        {loc:`${base}/area/tsunagi`,priority:"0.8",freq:"daily"},
        {loc:`${base}/area/nishiki`,priority:"0.8",freq:"daily"},
        {loc:`${base}/area/taragi`,priority:"0.8",freq:"daily"},
        {loc:`${base}/area/yunomae`,priority:"0.8",freq:"daily"},
        {loc:`${base}/area/mizukami`,priority:"0.8",freq:"daily"},
        {loc:`${base}/area/sagara`,priority:"0.8",freq:"daily"},
        {loc:`${base}/area/itsuki`,priority:"0.8",freq:"daily"},
        {loc:`${base}/area/yamae`,priority:"0.8",freq:"daily"},
        {loc:`${base}/area/kuma`,priority:"0.8",freq:"daily"},
        {loc:`${base}/area/asagiri`,priority:"0.8",freq:"daily"},
        {loc:`${base}/area/reihoku`,priority:"0.8",freq:"daily"},

        {loc:`${base}/listing-form.html`,priority:"0.6",freq:"monthly"},
        {loc:`${base}/about.html`,priority:"0.5",freq:"monthly"},
        {loc:`${base}/faq.html`,priority:"0.5",freq:"monthly"},
        {loc:`${base}/contact.html`,priority:"0.4",freq:"monthly"}
      ];

      if(env.DB){
        try{
          const r=await env.DB.prepare(`
            SELECT slug,updated_at
            FROM shops
            WHERE is_published=1
            ORDER BY updated_at DESC
          `).all();

          for(const s of (r.results||[])){
            if(!s.slug)continue;
            urls.push({
              loc:`${base}/shop.html?slug=${encodeURIComponent(s.slug)}`,
              lastmod:s.updated_at||"",
              priority:"0.8",
              freq:"weekly"
            });
          }
        }catch(e){
          console.error("sitemap generation error",e);
        }
      }

      const escXml=v=>String(v||"")
        .replace(/&/g,"&amp;")
        .replace(/</g,"&lt;")
        .replace(/>/g,"&gt;")
        .replace(/"/g,"&quot;")
        .replace(/'/g,"&apos;");

      const xml=`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(x=>`  <url>
    <loc>${escXml(x.loc)}</loc>${x.lastmod?`
    <lastmod>${escXml(String(x.lastmod).replace(" ","T"))}</lastmod>`:""}
    <changefreq>${x.freq}</changefreq>
    <priority>${x.priority}</priority>
  </url>`).join("\n")}
</urlset>`;

      return new Response(xml,{
        headers:{
          "content-type":"application/xml; charset=utf-8",
          "cache-control":"public, max-age=1800"
        }
      });
    }


    if(url.pathname==="/admin-login"){
      if(await validAdminRequest(request,env)){
        return Response.redirect(new URL("/admin.html?v=74",request.url).toString(),302);
      }
      return new Response(LOGIN_HTML,{headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store"}});
    }

    if(url.pathname==="/api/admin/login" && request.method==="POST"){
      const missing=[];
      if(!env.ADMIN_EMAIL)missing.push("ADMIN_EMAIL");
      if(!env.ADMIN_PASSWORD)missing.push("ADMIN_PASSWORD");
      if(!env.ADMIN_SESSION_SECRET)missing.push("ADMIN_SESSION_SECRET");
      if(missing.length){
        return json({ok:false,error:"ADMIN_AUTH_NOT_CONFIGURED",missing},{status:500});
      }
      let body={};try{body=await request.json()}catch{}
      const email=String(body.email||"").trim().toLowerCase();
      const password=String(body.password||"");
      if(!authEqual(email,String(env.ADMIN_EMAIL).trim().toLowerCase())||!authEqual(password,String(env.ADMIN_PASSWORD))){
        return json({ok:false,error:"INVALID_CREDENTIALS"},{status:401});
      }
      const token=await makeAdminSession(env);
      return new Response(JSON.stringify({ok:true,token,expires_in_days:ADMIN_SESSION_DAYS}),{
        status:200,
        headers:{
          "content-type":"application/json; charset=utf-8",
          "cache-control":"no-store",
          "set-cookie":setAdminCookie(token)
        }
      });
    }

    if(url.pathname==="/api/admin/logout" && request.method==="POST"){
      return new Response(JSON.stringify({ok:true}),{
        headers:{
          "content-type":"application/json; charset=utf-8",
          "cache-control":"no-store",
          "set-cookie":clearAdminCookie()
        }
      });
    }

    if(url.pathname==="/admin.html"){
      // 管理APIはBearerトークンで保護。ページ自体はJS側でログイン状態を確認。
    }


    const blockedPublicPages=new Set([
      "/owner-portal.html",
      "/shop-support.html",
      "/shop-update.html",
      "/photo-submit.html",
      "/event-submit.html",
      "/coupon-submit.html"
    ]);
    if(blockedPublicPages.has(url.pathname)){
      return new Response("Not Found",{status:404,headers:{"Content-Type":"text/plain; charset=utf-8","Cache-Control":"no-store"}});
    }

    if(!env.DB && url.pathname.startsWith("/api/")) return json({ok:false,error:"D1_NOT_BOUND"},{status:503});

    if(env.DB && url.pathname.startsWith("/api/")){
      await ensureListingStatusColumn(env);
    }

    if(url.pathname==="/api/shops" && request.method==="GET"){
      const r=await env.DB.prepare(`
        SELECT * FROM shops WHERE is_published=1
        ORDER BY is_featured DESC, COALESCE(updated_at,published_at,created_at) DESC, sort_order ASC, id DESC
      `).all();
      return json({ok:true,shops:(r.results||[]).map(publicShopRow)});
    }


    // 店舗ページの閲覧・導線クリックを集計
    const analyticsMatch=url.pathname.match(/^\/api\/analytics\/([^/]+)$/);
    if(analyticsMatch && request.method==="POST"){
      const slug=decodeURIComponent(analyticsMatch[1]);
      let x={}; try{x=await request.json()}catch{}
      const action=String(x.action||"");
      const allowed=new Set(["view","instagram","map","phone","website"]);
      if(!allowed.has(action)) return json({ok:false,error:"INVALID_ACTION"},{status:400});

      const s=await env.DB.prepare("SELECT id FROM shops WHERE slug=? AND is_published=1 LIMIT 1").bind(slug).first();
      if(!s) return json({ok:false,error:"NOT_FOUND"},{status:404});

      await env.DB.prepare(`
        INSERT INTO shop_analytics (shop_id,action,created_at)
        VALUES (?,?,CURRENT_TIMESTAMP)
      `).bind(s.id,action).run();

      return json({ok:true},{status:201});
    }

    if(url.pathname.startsWith("/api/shops/") && request.method==="GET"){
      const slug=decodeURIComponent(url.pathname.replace("/api/shops/",""));
      const s=await env.DB.prepare("SELECT * FROM shops WHERE slug=? AND is_published=1 LIMIT 1").bind(slug).first();
      return s?json({ok:true,shop:publicShopRow(s)}):json({ok:false,error:"NOT_FOUND"},{status:404});
    }


    if(url.pathname==="/api/news" && request.method==="GET"){
      const {results}=await env.DB.prepare(`
        SELECT name, slug, published_at, updated_at, created_at, is_new
        FROM shops
        WHERE is_published=1 AND is_new=1 AND COALESCE(listing_status,'published')='published'
        ORDER BY COALESCE(updated_at,published_at,created_at) DESC, id DESC
        LIMIT 8
      `).all();
      return json({ok:true,news:(results||[]).map(s=>({
        type:"shop",
        name:s.name,
        slug:s.slug,
        date:s.updated_at||s.published_at||s.created_at
      }))});
    }

    if(url.pathname==="/api/jobs" && request.method==="GET"){
      const r=await env.DB.prepare(`
        SELECT jobs.*, shops.name AS shop_name, shops.slug AS shop_slug
        FROM jobs LEFT JOIN shops ON shops.id=jobs.shop_id
        WHERE jobs.is_published=1
        ORDER BY jobs.sort_order ASC, jobs.created_at DESC
      `).all();
      return json({ok:true,jobs:r.results||[]});
    }

    if(url.pathname==="/api/submissions" && request.method==="POST"){
      let x; try{x=await request.json()}catch{return json({ok:false,error:"INVALID_JSON"},{status:400})}
      if(!t(x.shop_name,150)) return json({ok:false,error:"SHOP_NAME_REQUIRED"},{status:400});
      await env.DB.prepare(`
        INSERT INTO submissions (
          shop_name, contact_name, email, phone, address, hours, holiday, instagram,
          genre, features, description, budget_min, budget_max, seats, wants_job, note
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).bind(
        t(x.shop_name,150),t(x.contact_name,150),t(x.email,200),t(x.phone,80),
        t(x.address,300),t(x.hours,150),t(x.holiday,120),t(x.instagram,500),
        t(x.genre,120),t(x.features,1000),t(x.description,5000),ni(x.budget_min),
        ni(x.budget_max),ni(x.seats),b(x.wants_job),t(x.note,3000)
      ).run();

      let notification={ok:false,error:"NOT_ATTEMPTED"};
      try{
        notification=await notifyNewSubmission(env,x);
      }catch(e){
        notification={ok:false,error:"NOTIFICATION_EXCEPTION"};
      }

      // メール通知に失敗しても、掲載申込み自体は正常に保存済みとして返す
      return json({ok:true,notification_sent:!!notification.ok},{status:201});
    }


    if(url.pathname==="/api/owner/me" && request.method==="GET"){
      const shop=await ownerShop(request,env);
      if(!shop)return json({ok:false,error:"OWNER_TOKEN_INVALID"},{status:401});
      return json({ok:true,shop:{
        id:shop.id,name:shop.name,name_kana:shop.name_kana,area:shop.area,address:shop.address,
        hours:shop.hours,holiday:shop.holiday,instagram:shop.instagram,genre:shop.genre,
        features:shop.features,description:shop.description,budget_min:shop.budget_min,
        budget_max:shop.budget_max,seats:shop.seats,phone:shop.phone,image_url:shop.image_url,
        is_recruiting:shop.is_recruiting,is_published:shop.is_published
      }});
    }

    if(url.pathname==="/api/owner/requests" && request.method==="GET"){
      const shop=await ownerShop(request,env);
      if(!shop)return json({ok:false,error:"OWNER_TOKEN_INVALID"},{status:401});
      const r=await env.DB.prepare(`
        SELECT id,request_type,status,created_at,reviewed_at
        FROM owner_requests WHERE shop_id=? ORDER BY id DESC LIMIT 30
      `).bind(shop.id).all();
      return json({ok:true,requests:r.results||[]});
    }

    if(url.pathname==="/api/owner/requests" && request.method==="POST"){
      const shop=await ownerShop(request,env);
      if(!shop)return json({ok:false,error:"OWNER_TOKEN_INVALID"},{status:401});

      let x;
      try{x=await request.json()}catch{
        return json({ok:false,error:"INVALID_JSON"},{status:400});
      }

      const requestType=t(x.request_type,30);
      const payload=JSON.stringify(x.payload||{});

      if(!["profile","photo","job","event","coupon"].includes(requestType)){
        return json({ok:false,error:"INVALID_REQUEST_TYPE"},{status:400});
      }

      // 店舗情報変更は即時反映
      if(requestType==="profile"){
        const p=x.payload||{};

        const current=await env.DB.prepare("SELECT * FROM shops WHERE id=?").bind(shop.id).first();
        if(!current)return json({ok:false,error:"SHOP_NOT_FOUND"},{status:404});

        const merged={
          ...current,
          name: p.name ?? current.name,
          name_kana: p.name_kana ?? current.name_kana,
          area: p.area ?? current.area,
          address: p.address ?? current.address,
          hours: p.hours ?? current.hours,
          holiday: p.holiday ?? current.holiday,
          instagram: p.instagram ?? current.instagram,
          genre: p.genre ?? current.genre,
          features: p.features ?? current.features,
          description: p.description ?? current.description,
          budget_min: p.budget_min ?? current.budget_min,
          budget_max: p.budget_max ?? current.budget_max,
          seats: p.seats ?? current.seats,
          phone: p.phone ?? current.phone
        };

        await env.DB.prepare(`
          UPDATE shops SET
            name=?,name_kana=?,area=?,address=?,hours=?,holiday=?,
            instagram=?,genre=?,features=?,description=?,
            budget_min=?,budget_max=?,seats=?,phone=?,
            updated_at=CURRENT_TIMESTAMP
          WHERE id=?
        `).bind(
          t(merged.name,180),
          t(merged.name_kana,180),
          t(merged.area,120),
          t(merged.address,500),
          t(merged.hours,180),
          t(merged.holiday,180),
          t(merged.instagram,500),
          t(merged.genre,500),
          t(merged.features,1000),
          t(merged.description,5000),
          ni(merged.budget_min),
          ni(merged.budget_max),
          ni(merged.seats),
          t(merged.phone,120),
          shop.id
        ).run();

        const r=await env.DB.prepare(`
          INSERT INTO owner_requests (shop_id,request_type,payload,status,reviewed_at)
          VALUES (?,?,?,'reviewed',CURRENT_TIMESTAMP)
        `).bind(shop.id,requestType,payload).run();

        // メール通知は申請処理を止めないようバックグラウンド送信
        if(ctx?.waitUntil){
          ctx.waitUntil(
            notifyOwnerRequest(env,current,requestType,p,true)
              .catch(e=>console.error("owner profile notification failed",e))
          );
        }

        return json({
          ok:true,
          id:r.meta?.last_row_id,
          auto_applied:true,
          status:"reviewed"
        },{status:201});
      }

      // 写真・求人・イベント・クーポンは従来通り承認待ち
      const r=await env.DB.prepare(`
        INSERT INTO owner_requests (shop_id,request_type,payload,status)
        VALUES (?,?,?,'pending')
      `).bind(shop.id,requestType,payload).run();

      // 写真・求人・イベント・クーポン申請もメール通知
      if(ctx?.waitUntil){
        ctx.waitUntil(
          notifyOwnerRequest(env,shop,requestType,x.payload||{},false)
            .catch(e=>console.error("owner request notification failed",e))
        );
      }

      return json({
        ok:true,
        id:r.meta?.last_row_id,
        auto_applied:false,
        status:"pending"
      },{status:201});
    }

    if(url.pathname==="/api/owner/upload" && request.method==="POST"){
      const shop=await ownerShop(request,env);
      if(!shop)return json({ok:false,error:"OWNER_TOKEN_INVALID"},{status:401});
      if(!env.IMAGES)return json({ok:false,error:"R2_NOT_BOUND"},{status:503});
      const fd=await request.formData();
      const file=fd.get("file");
      if(!file||typeof file==="string")return json({ok:false,error:"FILE_REQUIRED"},{status:400});
      if(file.size>5*1024*1024)return json({ok:false,error:"FILE_TOO_LARGE"},{status:413});
      const allowedTypes=new Set(["image/jpeg","image/png","image/webp"]);
      if(!allowedTypes.has(file.type))return json({ok:false,error:"IMAGE_TYPE_NOT_ALLOWED"},{status:415});
      const ext=file.type==="image/png"?"png":file.type==="image/webp"?"webp":"jpg";
      const key=`owner-requests/${shop.id}/${Date.now()}-${crypto.randomUUID()}.${ext}`;
      await env.IMAGES.put(key,await file.arrayBuffer(),{httpMetadata:{contentType:file.type}});
      return json({ok:true,key,url:`/media/${encodeURIComponent(key)}`});
    }

    if(url.pathname.startsWith("/media/") && request.method==="GET"){
      if(!env.IMAGES) return new Response("R2 not configured",{status:404});
      const key=decodeURIComponent(url.pathname.replace("/media/",""));
      const obj=await env.IMAGES.get(key);
      if(!obj) return new Response("Not found",{status:404});
      const h=new Headers(); obj.writeHttpMetadata(h); h.set("etag",obj.httpEtag); h.set("cache-control","public,max-age=86400");
      return new Response(obj.body,{headers:h});
    }


    if(url.pathname==="/api/admin/status" && request.method==="GET"){
      return json({
        ok:true,
        authenticated:await validAdminRequest(request,env),
        db_bound:!!env.DB
      });
    }

    // GitHub connection status is read-only and contains no secret value.
    // Keep it outside the admin auth guard so the Site Update screen can
    // verify Cloudflare Secret / GitHub connectivity even if a stale admin
    // session token is present on the browser. All file read/write endpoints
    // remain protected by the admin auth guard below.
    if(url.pathname==="/api/admin/github/status" && request.method==="GET"){
      const c=kbnGithubConfig(env);
      if(!c.token){
        return json({
          ok:true,
          configured:false,
          connected:false,
          owner:c.owner,
          repo:c.repo,
          branch:c.branch,
          editable_files:KBN_GITHUB_EDITABLE_FILES
        });
      }
      try{
        const repo=await kbnGithubApi(
          env,
          `/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}`
        );
        return json({
          ok:true,
          configured:true,
          connected:true,
          owner:c.owner,
          repo:c.repo,
          branch:c.branch,
          repo_url:repo.html_url||"",
          editable_files:KBN_GITHUB_EDITABLE_FILES
        });
      }catch(e){
        return json({
          ok:true,
          configured:true,
          connected:false,
          owner:c.owner,
          repo:c.repo,
          branch:c.branch,
          error:e.message,
          editable_files:KBN_GITHUB_EDITABLE_FILES
        });
      }
    }

    if(url.pathname.startsWith("/api/admin/") && !["/api/admin/login","/api/admin/logout","/api/admin/status"].includes(url.pathname)){
      if(!(await validAdminRequest(request,env))) return json({ok:false,error:"ADMIN_AUTH_REQUIRED"},{status:401});



      // ---------- GitHub site update ----------

      if(url.pathname==="/api/admin/deploy-status" && request.method==="GET"){
        const accountId=String(env.CLOUDFLARE_ACCOUNT_ID||"").trim();
        const apiToken=String(env.CLOUDFLARE_API_TOKEN||"").trim();
        const workerName=String(env.CLOUDFLARE_WORKER_NAME||"").trim();
        let workerTag=String(env.CLOUDFLARE_WORKER_TAG||"").trim();
        if(!accountId || !apiToken || !workerName){
          return json({ok:true,configured:false,missing:[!accountId&&"CLOUDFLARE_ACCOUNT_ID",!apiToken&&"CLOUDFLARE_API_TOKEN",!workerName&&"CLOUDFLARE_WORKER_NAME"].filter(Boolean)});
        }
        const headers={"Authorization":`Bearer ${apiToken}`,"Accept":"application/json"};
        try{
          if(!workerTag){
            const sr=await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/scripts`,{headers});
            const sd=await sr.json();
            if(!sr.ok || !sd?.success)throw new Error(sd?.errors?.[0]?.message||`WORKER_LIST_HTTP_${sr.status}`);
            const match=(Array.isArray(sd.result)?sd.result:[]).find(x=>String(x?.id||"")===workerName);
            workerTag=String(match?.tag||"");
            if(!workerTag)throw new Error("CLOUDFLARE_WORKER_NOT_FOUND");
          }
          const br=await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/builds/workers/${encodeURIComponent(workerTag)}/builds`,{headers});
          const bd=await br.json();
          if(!br.ok || !bd?.success)throw new Error(bd?.errors?.[0]?.message||`BUILDS_HTTP_${br.status}`);
          const raw=Array.isArray(bd.result)?bd.result:(Array.isArray(bd.result?.builds)?bd.result.builds:[]);
          const builds=raw.slice(0,10).map(x=>({
            build_uuid:x?.build_uuid||x?.id||"",
            // Cloudflare Builds API: status = queued/initializing/running/stopped,
            // build_outcome = success/fail/skipped/cancelled/terminated.
            // stopped の場合は build_outcome を優先して管理画面へ渡す。
            status:(String(x?.status||"").toLowerCase()==="stopped" && x?.build_outcome)
              ? x.build_outcome
              : (x?.status||x?.build_status||x?.build_outcome||"unknown"),
            raw_status:x?.status||"",
            build_outcome:x?.build_outcome||"",
            branch:x?.build_trigger_metadata?.branch||x?.branch||x?.trigger?.branch||"",
            commit_hash:x?.build_trigger_metadata?.commit_hash||x?.commit_hash||"",
            message:x?.build_trigger_metadata?.commit_message||x?.commit_message||x?.trigger?.trigger_name||"",
            trigger:x?.trigger?.trigger_name||x?.build_trigger_source||"",
            created_at:x?.created_at||x?.created_on||"",
            updated_at:x?.updated_at||x?.completed_at||x?.stopped_on||x?.modified_on||x?.created_at||x?.created_on||""
          })).sort((a,b)=>new Date(b.created_at||0)-new Date(a.created_at||0));
          return json({ok:true,configured:true,worker_name:workerName,worker_tag:workerTag,builds});
        }catch(e){
          return json({ok:false,configured:true,error:"CLOUDFLARE_BUILDS_FAILED",message:e?.message||"UNKNOWN_ERROR"},502);
        }
      }

      if(url.pathname==="/api/admin/github/status" && request.method==="GET"){
        const c=kbnGithubConfig(env);
        if(!c.token){
          return json({
            ok:true,
            configured:false,
            connected:false,
            owner:c.owner,
            repo:c.repo,
            branch:c.branch,
            editable_files:KBN_GITHUB_EDITABLE_FILES
          });
        }
        try{
          const repo=await kbnGithubApi(
            env,
            `/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}`
          );
          return json({
            ok:true,
            configured:true,
            connected:true,
            owner:c.owner,
            repo:c.repo,
            branch:c.branch,
            repo_url:repo.html_url||"",
            editable_files:KBN_GITHUB_EDITABLE_FILES
          });
        }catch(e){
          return json({
            ok:true,
            configured:true,
            connected:false,
            owner:c.owner,
            repo:c.repo,
            branch:c.branch,
            error:e.message,
            editable_files:KBN_GITHUB_EDITABLE_FILES
          });
        }
      }

      if(url.pathname==="/api/admin/github/file" && request.method==="GET"){
        const c=kbnGithubConfig(env);
        const path=t(url.searchParams.get("path"),180);
        if(!KBN_GITHUB_EDITABLE_FILES.includes(path)){
          return json({ok:false,error:"FILE_NOT_ALLOWED"},{status:400});
        }
        const ref=t(url.searchParams.get("ref"),100)||c.branch;
        try{
          const d=await kbnGithubApi(
            env,
            `/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`
          );
          if(Array.isArray(d)||d.type!=="file"){
            return json({ok:false,error:"NOT_A_FILE"},{status:400});
          }
          return json({
            ok:true,
            path,
            sha:d.sha,
            size:d.size,
            content:kbnBase64ToUtf8(d.content||""),
            html_url:d.html_url||"",
            ref
          });
        }catch(e){
          return json({
            ok:false,
            error:"GITHUB_READ_FAILED",
            detail:e.message
          },{status:e.status||502});
        }
      }

      if(url.pathname==="/api/admin/github/history" && request.method==="GET"){
        const c=kbnGithubConfig(env);
        const path=t(url.searchParams.get("path"),180);
        if(!KBN_GITHUB_EDITABLE_FILES.includes(path)){
          return json({ok:false,error:"FILE_NOT_ALLOWED"},{status:400});
        }
        try{
          const commits=await kbnGithubApi(
            env,
            `/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/commits?sha=${encodeURIComponent(c.branch)}&path=${encodeURIComponent(path)}&per_page=12`
          );
          return json({
            ok:true,
            path,
            commits:(Array.isArray(commits)?commits:[]).map(x=>({
              sha:x.sha||"",
              message:x.commit?.message||"",
              date:x.commit?.committer?.date||x.commit?.author?.date||"",
              author:x.commit?.author?.name||x.author?.login||""
            }))
          });
        }catch(e){
          return json({ok:false,error:"GITHUB_HISTORY_FAILED",detail:e.message},{status:e.status||502});
        }
      }

      if(url.pathname==="/api/admin/github/restore" && request.method==="POST"){
        const c=kbnGithubConfig(env);
        let x;
        try{x=await request.json()}
        catch{return json({ok:false,error:"INVALID_JSON"},{status:400})}

        const path=t(x.path,180);
        const targetSha=t(x.target_sha,100);
        const currentSha=t(x.current_sha,100);
        const confirmation=t(x.confirm,50);

        if(!KBN_GITHUB_EDITABLE_FILES.includes(path)){
          return json({ok:false,error:"FILE_NOT_ALLOWED"},{status:400});
        }
        if(!targetSha||!currentSha){
          return json({ok:false,error:"SHA_REQUIRED"},{status:400});
        }
        if(confirmation!=="この版に戻す"){
          return json({ok:false,error:"CONFIRM_REQUIRED"},{status:400});
        }

        try{
          const old=await kbnGithubApi(
            env,
            `/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(targetSha)}`
          );
          if(Array.isArray(old)||old.type!=="file"){
            return json({ok:false,error:"NOT_A_FILE"},{status:400});
          }
          const content=kbnBase64ToUtf8(old.content||"");
          if(content.length>900000){
            return json({ok:false,error:"FILE_TOO_LARGE"},{status:413});
          }

          const result=await kbnGithubApi(
            env,
            `/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/contents/${encodeURIComponent(path)}`,
            {
              method:"PUT",
              headers:{"content-type":"application/json"},
              body:JSON.stringify({
                message:`admin: restore ${path} to ${targetSha.slice(0,10)}`,
                content:kbnUtf8ToBase64(content),
                sha:currentSha,
                branch:c.branch
              })
            }
          );

          return json({
            ok:true,
            path,
            restored_from:targetSha,
            commit_sha:result.commit?.sha||"",
            commit_url:result.commit?.html_url||"",
            message:"過去版へ復元しました。復元操作もGitHub履歴に残っています。"
          });
        }catch(e){
          return json({ok:false,error:"GITHUB_RESTORE_FAILED",detail:e.message},{status:e.status||502});
        }
      }

      if(url.pathname==="/api/admin/github/file" && request.method==="PUT"){
        const c=kbnGithubConfig(env);
        let x;
        try{x=await request.json()}
        catch{return json({ok:false,error:"INVALID_JSON"},{status:400})}

        const path=t(x.path,180);
        const sha=t(x.sha,100);
        const content=String(x.content??"");
        const message=t(x.message,180)||`admin: update ${path}`;
        const confirmation=t(x.confirm,50);

        if(!KBN_GITHUB_EDITABLE_FILES.includes(path)){
          return json({ok:false,error:"FILE_NOT_ALLOWED"},{status:400});
        }
        if(confirmation!=="GITHUBへ反映"){
          return json({ok:false,error:"CONFIRM_REQUIRED"},{status:400});
        }
        if(!sha){
          return json({ok:false,error:"SHA_REQUIRED"},{status:400});
        }
        if(content.length>900000){
          return json({ok:false,error:"FILE_TOO_LARGE"},{status:413});
        }

        try{
          const result=await kbnGithubApi(
            env,
            `/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/contents/${encodeURIComponent(path)}`,
            {
              method:"PUT",
              headers:{"content-type":"application/json"},
              body:JSON.stringify({
                message,
                content:kbnUtf8ToBase64(content),
                sha,
                branch:c.branch
              })
            }
          );

          return json({
            ok:true,
            path,
            commit_sha:result.commit?.sha||"",
            commit_url:result.commit?.html_url||"",
            file_url:result.content?.html_url||"",
            message:"GitHubへ反映しました。Cloudflareの自動デプロイが開始されます。"
          });
        }catch(e){
          return json({
            ok:false,
            error:"GITHUB_UPDATE_FAILED",
            detail:e.message,
            github_status:e.status||null
          },{status:e.status||502});
        }
      }



      if(url.pathname==="/api/admin/analytics/daily" && request.method==="GET"){
        try{
        const shopIdRaw=url.searchParams.get("shop_id");
        const shopId=shopIdRaw?Number(shopIdRaw):null;
        const daysRaw=Number(url.searchParams.get("days")||30);
        const days=Math.max(1,Math.min(90,Number.isFinite(daysRaw)?daysRaw:30));

        let sql=`
          SELECT
            date(datetime(a.created_at,'+9 hours')) AS day,
            SUM(CASE WHEN a.action='view' THEN 1 ELSE 0 END) AS views,
            SUM(CASE WHEN a.action!='view' THEN 1 ELSE 0 END) AS reactions,
            SUM(CASE WHEN a.action='instagram' THEN 1 ELSE 0 END) AS instagram_clicks,
            SUM(CASE WHEN a.action='map' THEN 1 ELSE 0 END) AS map_clicks,
            SUM(CASE WHEN a.action='phone' THEN 1 ELSE 0 END) AS phone_clicks,
            SUM(CASE WHEN a.action='website' THEN 1 ELSE 0 END) AS website_clicks
          FROM shop_analytics a
          WHERE datetime(a.created_at,'+9 hours') >= datetime('now','+9 hours',?)
        `;
        const binds=[`-${days-1} days`];

        if(shopId){
          sql+=" AND a.shop_id=?";
          binds.push(shopId);
        }

        sql+=`
          GROUP BY day
          ORDER BY day DESC
        `;

        const r=await env.DB.prepare(sql).bind(...binds).all();
        return json({ok:true,days,daily:r.results||[]});
      
        }catch(e){
          console.error("admin analytics daily failed",e);
          return json({ok:false,error:"ADMIN_ANALYTICS_DAILY_FAILED",message:String(e?.message||e)},{status:500});
        }
      }

      if(url.pathname==="/api/admin/analytics" && request.method==="GET"){
        try{
        const r=await env.DB.prepare(`
          SELECT
            s.id,s.name,s.slug,
            SUM(CASE WHEN a.action='view' THEN 1 ELSE 0 END) AS views,
            SUM(CASE WHEN a.action='instagram' THEN 1 ELSE 0 END) AS instagram_clicks,
            SUM(CASE WHEN a.action='map' THEN 1 ELSE 0 END) AS map_clicks,
            SUM(CASE WHEN a.action='phone' THEN 1 ELSE 0 END) AS phone_clicks,
            SUM(CASE WHEN a.action='website' THEN 1 ELSE 0 END) AS website_clicks,
            SUM(CASE WHEN a.action='view' AND a.created_at>=datetime('now','-30 days') THEN 1 ELSE 0 END) AS views_30d,
            SUM(CASE WHEN a.action!='view' AND a.created_at>=datetime('now','-30 days') THEN 1 ELSE 0 END) AS clicks_30d
          FROM shops s
          LEFT JOIN shop_analytics a ON a.shop_id=s.id
          GROUP BY s.id,s.name,s.slug
          ORDER BY views_30d DESC, views DESC, s.id DESC
        `).all();
        return json({ok:true,analytics:r.results||[]});
      
        }catch(e){
          console.error("admin analytics failed",e);
          return json({ok:false,error:"ADMIN_ANALYTICS_FAILED",message:String(e?.message||e)},{status:500});
        }
      }


      const shopImagesRoute=url.pathname.match(/^\/api\/admin\/shops\/(\d+)\/images$/);
      if(shopImagesRoute && request.method==="GET"){
        const shopId=Number(shopImagesRoute[1]);
        const r=await env.DB.prepare("SELECT id,image_url,sort_order,created_at FROM shop_images WHERE shop_id=? ORDER BY sort_order ASC,id ASC").bind(shopId).all();
        return json({ok:true,images:r.results||[]});
      }
      if(shopImagesRoute && request.method==="POST"){
        const shopId=Number(shopImagesRoute[1]);
        let x={};try{x=await request.json()}catch{}
        const imageUrl=t(x.image_url,1000);
        if(!imageUrl)return json({ok:false,error:"IMAGE_URL_REQUIRED"},{status:400});
        const sort=ni(x.sort_order)??100;
        const r=await env.DB.prepare("INSERT INTO shop_images (shop_id,image_url,sort_order,created_at) VALUES (?,?,?,CURRENT_TIMESTAMP)").bind(shopId,imageUrl,sort).run();
        return json({ok:true,id:r.meta?.last_row_id},{status:201});
      }
      const shopImageDelete=url.pathname.match(/^\/api\/admin\/shop-images\/(\d+)$/);
      if(shopImageDelete && request.method==="DELETE"){
        await env.DB.prepare("DELETE FROM shop_images WHERE id=?").bind(Number(shopImageDelete[1])).run();
        return json({ok:true});
      }


      

      if(url.pathname==="/api/admin/leads/repair-areas" && request.method==="POST"){
        let x={};
        try{x=await request.json()}catch{}

        try{
          const result=await repairExistingIndependentListingAreas(env,{
            limit:Math.max(1,Math.min(Number(x.limit)||100,500))
          });
          return json(result,{headers:{"Cache-Control":"no-store"}});
        }catch(e){
          console.error("repair-areas failed",e);
          return json({
            ok:false,
            error:"REPAIR_AREAS_FAILED",
            message:String(e?.message||e||"UNKNOWN_ERROR").slice(0,500)
          },{status:500,headers:{"Cache-Control":"no-store"}});
        }
      }

      if(url.pathname==="/api/admin/leads/refresh-existing" && request.method==="POST"){
        let x={};
        try{x=await request.json()}catch{}

        try{
          const result=await refreshIndependentListings(env,{
            limit:Math.max(1,Math.min(Number(x.limit)||10,30)),
            afterId:Math.max(0,Number(x.after_id)||0),
            revalidate:!!x.revalidate,
            force:!!x.force
          });

          return json(result,{headers:{"Cache-Control":"no-store"}});
        }catch(e){
          console.error("refresh-existing failed",e);
          return json({
            ok:false,
            error:"REFRESH_EXISTING_FAILED",
            message:String(e?.message||e||"UNKNOWN_ERROR").slice(0,500)
          },{status:500,headers:{"Cache-Control":"no-store"}});
        }
      }

      if(url.pathname==="/api/admin/leads/auto-discover" && request.method==="POST"){
        let x={}; try{x=await request.json()}catch{}
        const max=Math.max(1,Math.min(Number(x.max_listings)||10,20));
        const pairs=Math.max(1,Math.min(Number(x.pair_limit)||6,10));
        const perPair=Math.max(1,Math.min(Number(x.per_pair_limit)||2,3));

        try{
          const result=await autoDiscover(env,request,max,pairs,perPair);
          return json(result,{headers:{"Cache-Control":"no-store"}});
        }catch(e){
          console.error("auto-discover failed",e);
          return json({
            ok:false,
            error:"AUTO_DISCOVER_FAILED",
            message:String(e?.message||e||"UNKNOWN_ERROR").slice(0,500)
          },{status:500,headers:{"Cache-Control":"no-store"}});
        }
      }

if(url.pathname==="/api/admin/leads/search-config" && request.method==="GET"){
        const cfg=leadSearchConfig(env);
        return json({
          ok:true,
          configured:!!cfg.apiKey,
          has_api_key:!!cfg.apiKey,
          provider:"serpapi"
        });
      }

      if(url.pathname==="/api/admin/leads/search" && request.method==="GET"){
        const area=t(url.searchParams.get("area")||"熊本",120);
        const type=t(url.searchParams.get("type")||"bar",50);
        const start=Math.max(1,Math.min(91,Number(url.searchParams.get("start")||1)));

        const result=await searchInstagramLeads(env,{area,type,start});

        if(!result.ok && result.error==="SERPAPI_NOT_CONFIGURED"){
          return json(result,{status:503});
        }

        if(!result.ok){
          return json(result,{status:502});
        }

        return json(result);
      }


      if(url.pathname==="/api/admin/leads/provisional-shop" && request.method==="POST"){
        let x;
        try{x=await request.json()}
        catch{return json({ok:false,error:"INVALID_JSON"},{status:400})}

        const name=t(x.name,150);
        const area=t(x.area||"熊本",80);
        const snippet=t(x.snippet,2000);
        const genre=t(x.genre||"BAR",120);
        let instagram=t(x.instagram,500);

        if(!name)return json({ok:false,error:"SHOP_NAME_REQUIRED"},{status:400});

        const handle=String(instagram||"")
          .replace(/^https?:\/\/(www\.)?instagram\.com\//i,"")
          .replace(/^@/,"")
          .split(/[/?#]/)[0]
          .trim();

        instagram=handle?`https://www.instagram.com/${handle}/`:"";

        if(handle){
          const existing=await env.DB.prepare(
            "SELECT id,name,listing_status FROM shops WHERE LOWER(instagram) LIKE ? LIMIT 1"
          ).bind(`%${handle.toLowerCase()}%`).first();

          if(existing){
            return json({
              ok:false,
              error:"SHOP_ALREADY_LISTED",
              shop_id:existing.id,
              shop_name:existing.name,
              listing_status:existing.listing_status||"published"
            },{status:409});
          }
        }

        const description=snippet
          ? `${snippet}\n\n※本ページは、公開されている情報をもとにKUMAMOTO BAR NAVIが独自に掲載しています。掲載内容の修正・削除をご希望の場合は店舗様専用ページよりご連絡ください。`
          : "※本ページは、公開されている情報をもとにKUMAMOTO BAR NAVIが独自に掲載しています。掲載内容の修正・削除をご希望の場合は店舗様専用ページよりご連絡ください。";

        const slug=slugify(name);

        let r;
        try{
          r=await env.DB.prepare(`
            INSERT INTO shops (
              slug,name,name_kana,area,address,hours,holiday,instagram,genre,features,description,
              budget_min,budget_max,seats,phone,is_recruiting,is_published,image_url,image_key,
              is_featured,is_new,sort_order,listing_status,published_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'provisional',CURRENT_TIMESTAMP)
          `).bind(
            slug,name,"",area,"","","",instagram,genre,"",description,
            null,null,null,"",0,1,"","",
            0,1,100
          ).run();
        }catch(e){
          console.error("provisional shop insert failed",e);
          return json({
            ok:false,
            error:"PROVISIONAL_INSERT_FAILED",
            message:String(e?.message||e||"UNKNOWN_ERROR").slice(0,500)
          },{status:500});
        }

        const shopId=Number(r.meta?.last_row_id||0);

        const token=ownerToken();
        const hash=await sha256hex(token);

        await env.DB.prepare(
          "UPDATE shops SET owner_token_hash=?,owner_token_created_at=CURRENT_TIMESTAMP WHERE id=?"
        ).bind(hash,shopId).run();

        const origin=new URL(request.url).origin;

        return json({
          ok:true,
          shop_id:shopId,
          listing_status:"provisional",
          owner_url:`${origin}/owner.html?token=${encodeURIComponent(token)}`,
          public_url:`${origin}/shop.html?slug=${encodeURIComponent(slug)}`
        },{status:201});
      }

      const provisionalPublish=url.pathname.match(/^\/api\/admin\/shops\/(\d+)\/publish$/);
      if(provisionalPublish && request.method==="POST"){
        const id=Number(provisionalPublish[1]);
        const row=await env.DB.prepare("SELECT id,name FROM shops WHERE id=?").bind(id).first();
        if(!row)return json({ok:false,error:"NOT_FOUND"},{status:404});

        await env.DB.prepare(`
          UPDATE shops
          SET listing_status='published',
              published_at=CURRENT_TIMESTAMP,
              is_new=1,
              updated_at=CURRENT_TIMESTAMP
          WHERE id=?
        `).bind(id).run();

        return json({ok:true,shop_id:id,listing_status:"published"});
      }

      if(url.pathname==="/api/admin/shops" && request.method==="GET"){
        const r=await env.DB.prepare("SELECT * FROM shops ORDER BY sort_order ASC,id DESC").all();
        return json({ok:true,shops:r.results||[]});
      }
      if(url.pathname==="/api/admin/shops" && request.method==="POST"){
        let x;try{x=await request.json()}catch{return json({ok:false,error:"INVALID_JSON"},{status:400})}
        const s=shopPayload(x); if(!s.name||!s.area)return json({ok:false,error:"NAME_AND_AREA_REQUIRED"},{status:400});
        const r=await env.DB.prepare(`
          INSERT INTO shops (
            slug,name,name_kana,area,address,hours,holiday,instagram,genre,features,description,
            budget_min,budget_max,seats,phone,is_recruiting,is_published,image_url,image_key,
            is_featured,is_new,sort_order,listing_status,published_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CASE WHEN ?=1 THEN CURRENT_TIMESTAMP ELSE NULL END)
        `).bind(
          s.slug,s.name,s.name_kana,s.area,s.address,s.hours,s.holiday,s.instagram,s.genre,s.features,s.description,
          s.budget_min,s.budget_max,s.seats,s.phone,s.is_recruiting,s.is_published,s.image_url,s.image_key,
          s.is_featured,s.is_new,s.sort_order,s.listing_status,s.is_published
        ).run();
        return json({ok:true,id:r.meta?.last_row_id},{status:201});
      }

      const sm=url.pathname.match(/^\/api\/admin\/shops\/(\d+)$/);
      if(sm && request.method==="PUT"){
        const id=Number(sm[1]); let x;try{x=await request.json()}catch{return json({ok:false,error:"INVALID_JSON"},{status:400})}
        const ex=await env.DB.prepare("SELECT * FROM shops WHERE id=?").bind(id).first();
        if(!ex)return json({ok:false,error:"NOT_FOUND"},{status:404});
        const s=shopPayload({...ex,...x});
        await env.DB.prepare(`
          UPDATE shops SET slug=?,name=?,name_kana=?,area=?,address=?,hours=?,holiday=?,instagram=?,genre=?,features=?,
          description=?,budget_min=?,budget_max=?,seats=?,phone=?,is_recruiting=?,is_published=?,image_url=?,image_key=?,
          is_featured=?,is_new=?,sort_order=?,listing_status=?,
          published_at=CASE
            WHEN ?='provisional' AND ?='published' THEN CURRENT_TIMESTAMP
            WHEN ?=1 AND published_at IS NULL THEN CURRENT_TIMESTAMP
            ELSE published_at
          END,
          updated_at=CURRENT_TIMESTAMP WHERE id=?
        `).bind(
          s.slug,s.name,s.name_kana,s.area,s.address,s.hours,s.holiday,s.instagram,s.genre,s.features,
          s.description,s.budget_min,s.budget_max,s.seats,s.phone,s.is_recruiting,s.is_published,s.image_url,s.image_key,
          s.is_featured,s.is_new,s.sort_order,s.listing_status,ex.listing_status,s.listing_status,s.is_published,id
        ).run();
        return json({ok:true});
      }

      if(sm && request.method==="DELETE"){
        const id=Number(sm[1]);
        const deleted=[];
        try{
          const shop=await env.DB.prepare("SELECT id,name FROM shops WHERE id=?").bind(id).first();
          if(!shop)return json({ok:false,error:"NOT_FOUND"},{status:404});

          const tableExists=async(name)=>{
            const row=await env.DB.prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
            ).bind(name).first();
            return !!row;
          };

          const safeDelete=async(table,sql)=>{
            if(!(await tableExists(table)))return;
            try{
              await env.DB.prepare(sql).bind(id).run();
              deleted.push(table);
            }catch(e){
              throw new Error(`${table}: ${String(e?.message||e)}`);
            }
          };

          await safeDelete("shop_images","DELETE FROM shop_images WHERE shop_id=?");
          await safeDelete("shop_analytics","DELETE FROM shop_analytics WHERE shop_id=?");
          await safeDelete("jobs","DELETE FROM jobs WHERE shop_id=?");
          await safeDelete("owner_requests","DELETE FROM owner_requests WHERE shop_id=?");

          try{
            await env.DB.prepare("DELETE FROM shops WHERE id=?").bind(id).run();
            deleted.push("shops");
          }catch(e){
            throw new Error(`shops: ${String(e?.message||e)}`);
          }

          return json({
            ok:true,
            success:true,
            message:"削除しました",
            id,
            name:shop.name,
            deleted
          });
        }catch(e){
          console.error("shop delete failed",e);
          return json({
            ok:false,
            success:false,
            error:"DELETE_FAILED",
            message:String(e?.message||e),
            deleted
          },{status:500});
        }
      }


      const ot=url.pathname.match(/^\/api\/admin\/shops\/(\d+)\/owner-token$/);
      if(ot && request.method==="POST"){
        const id=Number(ot[1]);
        const shop=await env.DB.prepare("SELECT id,name FROM shops WHERE id=?").bind(id).first();
        if(!shop)return json({ok:false,error:"NOT_FOUND"},{status:404});
        const token=ownerToken();
        const hash=await sha256hex(token);
        await env.DB.prepare(`
          UPDATE shops SET owner_token_hash=?,owner_token_created_at=CURRENT_TIMESTAMP WHERE id=?
        `).bind(hash,id).run();
        return json({ok:true,url:`${url.origin}/owner.html?token=${encodeURIComponent(token)}`});
      }
      if(ot && request.method==="DELETE"){
        const id=Number(ot[1]);
        await env.DB.prepare(`
          UPDATE shops SET owner_token_hash=NULL,owner_token_created_at=NULL WHERE id=?
        `).bind(id).run();
        return json({ok:true});
      }

      if(url.pathname==="/api/admin/owner-requests" && request.method==="GET"){
        const r=await env.DB.prepare(`
          SELECT owner_requests.*,shops.name AS shop_name
          FROM owner_requests
          JOIN shops ON shops.id=owner_requests.shop_id
          ORDER BY CASE owner_requests.status WHEN 'pending' THEN 0 ELSE 1 END,
                   owner_requests.id DESC
        `).all();
        return json({ok:true,requests:r.results||[]});
      }

      const orPhoto=url.pathname.match(/^\/api\/admin\/owner-requests\/(\d+)\/apply-photo$/);
      if(orPhoto && request.method==="POST"){
        const id=Number(orPhoto[1]);
        const req=await env.DB.prepare(`
          SELECT owner_requests.*,shops.id AS target_shop_id
          FROM owner_requests
          JOIN shops ON shops.id=owner_requests.shop_id
          WHERE owner_requests.id=?
        `).bind(id).first();

        if(!req)return json({ok:false,error:"NOT_FOUND"},{status:404});
        if(req.request_type!=="photo")return json({ok:false,error:"NOT_PHOTO_REQUEST"},{status:400});

        let payload={};
        try{payload=JSON.parse(req.payload||"{}")}catch{}
        const imageUrl=t(payload.image_url||payload.url||"",1000);
        if(!imageUrl)return json({ok:false,error:"IMAGE_URL_NOT_FOUND"},{status:400});

        let body={};
        try{body=await request.json()}catch{}
        const mode=body.mode==="gallery"?"gallery":"main";

        if(mode==="gallery"){
          const maxRow=await env.DB.prepare("SELECT COALESCE(MAX(sort_order),0) AS m FROM shop_images WHERE shop_id=?").bind(req.target_shop_id).first();
          const nextSort=Number(maxRow?.m||0)+10;
          await env.DB.batch([
            env.DB.prepare("INSERT INTO shop_images (shop_id,image_url,sort_order,created_at) VALUES (?,?,?,CURRENT_TIMESTAMP)")
              .bind(req.target_shop_id,imageUrl,nextSort),
            env.DB.prepare("UPDATE owner_requests SET status='reviewed',reviewed_at=CURRENT_TIMESTAMP WHERE id=?").bind(id)
          ]);
        }else{
          await env.DB.batch([
            env.DB.prepare("UPDATE shops SET image_url=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(imageUrl,req.target_shop_id),
            env.DB.prepare("UPDATE owner_requests SET status='reviewed',reviewed_at=CURRENT_TIMESTAMP WHERE id=?").bind(id)
          ]);
        }

        return json({ok:true,image_url:imageUrl,shop_id:req.target_shop_id,mode});
      }



      const orm=url.pathname.match(/^\/api\/admin\/owner-requests\/(\d+)$/);
      if(orm && request.method==="PUT"){
        const id=Number(orm[1]);
        let x;try{x=await request.json()}catch{return json({ok:false,error:"INVALID_JSON"},{status:400})}
        const status=t(x.status,30);
        if(!["reviewed","rejected"].includes(status))return json({ok:false,error:"INVALID_STATUS"},{status:400});
        await env.DB.prepare(`
          UPDATE owner_requests SET status=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?
        `).bind(status,id).run();
        return json({ok:true});
      }

      if(url.pathname==="/api/admin/upload" && request.method==="POST"){
        if(!env.IMAGES)return json({ok:false,error:"R2_NOT_BOUND"},{status:503});
        const fd=await request.formData(); const file=fd.get("file");
        if(!file||typeof file==="string")return json({ok:false,error:"FILE_REQUIRED"},{status:400});
        if(file.size>8*1024*1024)return json({ok:false,error:"FILE_TOO_LARGE"},{status:413});
        const ext=(file.name.split(".").pop()||"jpg").toLowerCase().replace(/[^a-z0-9]/g,"");
        const key=`shops/${Date.now()}-${crypto.randomUUID()}.${ext}`;
        await env.IMAGES.put(key,file.stream(),{httpMetadata:{contentType:file.type||"application/octet-stream"}});
        return json({ok:true,key,url:`/media/${encodeURIComponent(key)}`});
      }


      if(url.pathname==="/api/admin/job-candidates" && request.method==="GET"){
        await ensureJobCandidatesTable(env);
        const r=await env.DB.prepare(`
          SELECT jc.*,shops.slug AS shop_slug
          FROM job_candidates jc
          LEFT JOIN shops ON shops.id=jc.shop_id
          WHERE jc.status='pending'
          ORDER BY jc.id DESC
          LIMIT 100
        `).all();
        return json({ok:true,candidates:r.results||[]});
      }

      if(url.pathname==="/api/admin/job-candidates/search" && request.method==="POST"){
        let x={};
        try{x=await request.json()}catch{}
        try{
          const result=await searchJobCandidatesForShops(env,{
            limit:Math.max(1,Math.min(Number(x.limit)||5,10))
          });
          return json(result,{headers:{"Cache-Control":"no-store"}});
        }catch(e){
          return json({
            ok:false,
            error:"JOB_SEARCH_FAILED",
            message:String(e?.message||e||"UNKNOWN_ERROR").slice(0,500)
          },{status:500});
        }
      }

      const jca=url.pathname.match(/^\/api\/admin\/job-candidates\/(\d+)\/draft$/);
      if(jca && request.method==="POST"){
        await ensureJobCandidatesTable(env);
        const id=Number(jca[1]);
        const c=await env.DB.prepare(`
          SELECT * FROM job_candidates WHERE id=? AND status='pending' LIMIT 1
        `).bind(id).first();

        if(!c)return json({ok:false,error:"NOT_FOUND"},{status:404});

        const r=await env.DB.prepare(`
          INSERT INTO jobs (
            shop_id,title,employment_type,salary,hours,description,contact,is_published,sort_order
          )
          VALUES (?,?,?,?,?,?,?,0,100)
        `).bind(
          c.shop_id,
          t(c.title,180)||"スタッフ募集",
          t(c.employment_type,120),
          t(c.salary,180),
          t(c.hours,180),
          t([
            c.description||"",
            c.features?`特徴：${c.features}`:"",
            c.source_url?`情報元：${c.source_url}`:""
          ].filter(Boolean).join("\n\n"),5000),
          ""
        ).run();

        await env.DB.prepare(`
          UPDATE job_candidates
          SET status='drafted',reviewed_at=CURRENT_TIMESTAMP
          WHERE id=?
        `).bind(id).run();

        return json({ok:true,job_id:r.meta?.last_row_id});
      }

      const jcr=url.pathname.match(/^\/api\/admin\/job-candidates\/(\d+)\/reject$/);
      if(jcr && request.method==="POST"){
        await ensureJobCandidatesTable(env);
        const id=Number(jcr[1]);
        await env.DB.prepare(`
          UPDATE job_candidates
          SET status='rejected',reviewed_at=CURRENT_TIMESTAMP
          WHERE id=?
        `).bind(id).run();
        return json({ok:true});
      }

      if(url.pathname==="/api/admin/jobs" && request.method==="GET"){
        const r=await env.DB.prepare(`
          SELECT jobs.*, shops.name AS shop_name FROM jobs
          LEFT JOIN shops ON shops.id=jobs.shop_id
          ORDER BY jobs.sort_order ASC,jobs.id DESC
        `).all();
        return json({ok:true,jobs:r.results||[]});
      }
      if(url.pathname==="/api/admin/jobs" && request.method==="POST"){
        let x;try{x=await request.json()}catch{return json({ok:false,error:"INVALID_JSON"},{status:400})}
        const r=await env.DB.prepare(`
          INSERT INTO jobs (shop_id,title,employment_type,salary,hours,description,contact,is_published,sort_order)
          VALUES (?,?,?,?,?,?,?,?,?)
        `).bind(ni(x.shop_id),t(x.title,180),t(x.employment_type,120),t(x.salary,180),t(x.hours,180),t(x.description,5000),t(x.contact,500),x.is_published===false?0:1,ni(x.sort_order)??100).run();
        return json({ok:true,id:r.meta?.last_row_id},{status:201});
      }
      const jm=url.pathname.match(/^\/api\/admin\/jobs\/(\d+)$/);
      if(jm && request.method==="PUT"){
        const id=Number(jm[1]); let x;try{x=await request.json()}catch{return json({ok:false,error:"INVALID_JSON"},{status:400})}
        await env.DB.prepare(`
          UPDATE jobs SET shop_id=?,title=?,employment_type=?,salary=?,hours=?,description=?,contact=?,
          is_published=?,sort_order=?,updated_at=CURRENT_TIMESTAMP WHERE id=?
        `).bind(ni(x.shop_id),t(x.title,180),t(x.employment_type,120),t(x.salary,180),t(x.hours,180),t(x.description,5000),t(x.contact,500),x.is_published===false?0:1,ni(x.sort_order)??100,id).run();
        return json({ok:true});
      }

      if(url.pathname==="/api/admin/submissions" && request.method==="GET"){
        const r=await env.DB.prepare("SELECT * FROM submissions ORDER BY id DESC").all();
        const rows=r.results||[];

        const enriched=[];
        for(const sub of rows){
          let duplicate=null;
          if(String(sub.status||"pending")==="pending"){
            try{ duplicate=await findSubmissionDuplicate(env,sub); }catch(e){ console.error("duplicate check failed",e); }
          }
          enriched.push({...sub,duplicate});
        }

        return json({ok:true,submissions:enriched});
      }
      const ap=url.pathname.match(/^\/api\/admin\/submissions\/(\d+)\/approve$/);
      if(ap && request.method==="POST"){
        const id=Number(ap[1]);
        const sub=await env.DB.prepare("SELECT * FROM submissions WHERE id=?").bind(id).first();
        if(!sub)return json({ok:false,error:"NOT_FOUND"},{status:404});
        if(String(sub.status||"pending")!=="pending"){
          return json({ok:false,error:"SUBMISSION_ALREADY_REVIEWED"},{status:409});
        }

        let body={};
        try{body=await request.json()}catch{}

        const duplicate=await findSubmissionDuplicate(env,sub);
        const requestedMergeId=Number(body?.merge_shop_id||0);
        const forceCreate=body?.force_create===true;

        // 管理画面で明示的に指定された既存店舗へ統合
        if(requestedMergeId){
          const merged=await mergeSubmissionIntoShop(env,sub,requestedMergeId);
          await env.DB.prepare(
            "UPDATE submissions SET status='approved',reviewed_at=CURRENT_TIMESTAMP WHERE id=?"
          ).bind(id).run();

          return json({
            ok:true,
            shop_id:Number(merged.id),
            merged:true,
            converted_from_provisional:String(merged.listing_status||"published")==="published",
            message:"EXISTING_SHOP_MERGED"
          });
        }

        // Instagram / 電話 / 店名+住所など、強い一致は自動統合
        if(duplicate?.strong && !forceCreate){
          const merged=await mergeSubmissionIntoShop(env,sub,duplicate.shop_id);
          await env.DB.prepare(
            "UPDATE submissions SET status='approved',reviewed_at=CURRENT_TIMESTAMP WHERE id=?"
          ).bind(id).run();

          return json({
            ok:true,
            shop_id:Number(merged.id),
            merged:true,
            auto_merged:true,
            duplicate,
            message:"DUPLICATE_AUTO_MERGED"
          });
        }

        // 店名類似など弱い候補がある場合は、勝手に新規作成しない
        if(duplicate && duplicate.score>=30 && !forceCreate){
          return json({
            ok:false,
            error:"DUPLICATE_CONFIRM_REQUIRED",
            message:"既存店舗と重複している可能性があります。",
            duplicate
          },{status:409});
        }

        const area=submissionArea(sub);
        const s=shopPayload({
          name:sub.shop_name,area,address:sub.address,hours:sub.hours,holiday:sub.holiday,
          instagram:sub.instagram,genre:sub.genre,features:sub.features,description:sub.description,
          budget_min:sub.budget_min,budget_max:sub.budget_max,seats:sub.seats,phone:sub.phone,
          is_recruiting:sub.wants_job,is_published:true,is_new:true,listing_status:"published"
        });

        const r=await env.DB.prepare(`
          INSERT INTO shops (
            slug,name,area,address,hours,holiday,instagram,genre,features,description,
            budget_min,budget_max,seats,phone,is_recruiting,is_published,is_new,listing_status,published_at
          )
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,'published',CURRENT_TIMESTAMP)
        `).bind(
          s.slug,s.name,s.area,s.address,s.hours,s.holiday,s.instagram,s.genre,s.features,s.description,
          s.budget_min,s.budget_max,s.seats,t(sub.phone,80),s.is_recruiting,1
        ).run();

        await env.DB.prepare(
          "UPDATE submissions SET status='approved',reviewed_at=CURRENT_TIMESTAMP WHERE id=?"
        ).bind(id).run();

        return json({ok:true,shop_id:r.meta?.last_row_id,merged:false});
      }
      const rp=url.pathname.match(/^\/api\/admin\/submissions\/(\d+)\/reject$/);
      if(rp && request.method==="POST"){
        await env.DB.prepare("UPDATE submissions SET status='rejected',reviewed_at=CURRENT_TIMESTAMP WHERE id=?").bind(Number(rp[1])).run();
        return json({ok:true});
      }

      return json({ok:false,error:"ADMIN_ROUTE_NOT_FOUND"},{status:404});
    }

    const assetResponse=await env.ASSETS.fetch(request);

    if(url.pathname==="/admin.html"){
      const h=new Headers(assetResponse.headers);
      h.set("Cache-Control","no-store, no-cache, must-revalidate, max-age=0");
      h.set("Pragma","no-cache");
      h.set("Expires","0");
      return new Response(assetResponse.body,{
        status:assetResponse.status,
        statusText:assetResponse.statusText,
        headers:h
      });
    }

    return assetResponse;
  }
};
