
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


// KBN v1.97: 求人付き掲載申込みの自動反映
async function ensureSubmissionJobColumns(env){
  const cols=[
    ["job_title","TEXT"],
    ["job_employment_type","TEXT"],
    ["job_salary","TEXT"],
    ["job_hours","TEXT"],
    ["job_description","TEXT"],
    ["job_contact","TEXT"]
  ];
  const info=await env.DB.prepare("PRAGMA table_info(submissions)").all();
  const names=new Set((info.results||[]).map(x=>String(x.name||"")));
  for(const [name,type] of cols){
    if(names.has(name))continue;
    try{
      await env.DB.prepare(`ALTER TABLE submissions ADD COLUMN ${name} ${type}`).run();
    }catch(e){
      const msg=String(e?.message||e||"");
      if(!/duplicate column/i.test(msg))throw e;
    }
  }
}

function kbnSubmissionJobText(sub){
  return [
    sub?.job_title,
    sub?.job_employment_type,
    sub?.job_salary,
    sub?.job_hours,
    sub?.job_description,
    sub?.job_contact,
    sub?.note,
    sub?.description,
    sub?.features
  ].filter(Boolean).join("\n").replace(/\r/g,"").trim();
}

function kbnJobIntentFromSubmission(sub){
  if(b(sub?.wants_job))return true;

  const text=kbnSubmissionJobText(sub);
  if(!text)return false;

  // 「求人あり」「スタッフ募集」などは単独でも強い判定
  if(/(?:求人\s*(?:あり|有|希望|掲載)|スタッフ\s*募集|従業員\s*募集|アルバイト\s*募集|正社員\s*募集|求人情報)/i.test(text)){
    return true;
  }

  // 備考などに複数の求人要素が書かれている場合も求人として判定
  const signals=[
    /(?:時給|日給|月給|給与|報酬)\s*[:：]?\s*[0-9０-９,，]+/i,
    /(?:勤務時間|シフト|勤務日|勤務時間帯)\s*[:：]/i,
    /(?:雇用形態|アルバイト|パート|正社員|業務委託)/i,
    /(?:応募方法|応募先|連絡先)\s*[:：]/i,
    /(?:仕事内容|募集職種|職種)\s*[:：]/i
  ];
  return signals.filter(rx=>rx.test(text)).length>=2;
}

function kbnExtractLabeledValue(text,labels,max=500){
  const src=String(text||"");
  const escaped=labels.map(x=>String(x).replace(/[.*+?^${}()|[\]\\]/g,"\\$&")).join("|");
  const rx=new RegExp(`(?:^|\\n)\\s*(?:${escaped})\\s*[:：]\\s*([^\\n]+)`,"i");
  const m=src.match(rx);
  return m?t(m[1],max):"";
}

function kbnExtractJobData(sub){
  const text=kbnSubmissionJobText(sub);

  let title=t(sub?.job_title,180);
  if(!title){
    title=kbnExtractLabeledValue(text,["求人タイトル","募集タイトル","募集職種","職種"],180);
  }
  if(!title){
    const m=text.match(/(?:スタッフ|アルバイト|正社員|パート)\s*募集[^\n]*/i);
    title=m?t(m[0],180):"スタッフ募集";
  }

  let employment=t(sub?.job_employment_type,120);
  if(!employment){
    employment=kbnExtractLabeledValue(text,["雇用形態","勤務形態"],120);
  }
  if(!employment){
    const types=[];
    if(/正社員/i.test(text))types.push("正社員");
    if(/アルバイト/i.test(text))types.push("アルバイト");
    if(/パート/i.test(text))types.push("パート");
    if(/業務委託/i.test(text))types.push("業務委託");
    employment=types.join("・")||"応相談";
  }

  let salary=t(sub?.job_salary,180);
  if(!salary){
    salary=kbnExtractLabeledValue(text,["給与","時給","日給","月給","報酬"],180);
  }
  if(!salary){
    const m=text.match(/(?:時給|日給|月給|給与|報酬)\s*[:：]?\s*[0-9０-９,，]+(?:円)?(?:\s*[〜～~-]\s*[0-9０-９,，]+(?:円)?)?/i);
    salary=m?t(m[0],180):"詳細は店舗へお問い合わせください";
  }

  let hours=t(sub?.job_hours,180);
  if(!hours){
    hours=kbnExtractLabeledValue(text,["勤務時間","勤務時間帯","シフト","勤務日"],180);
  }
  if(!hours){
    const m=text.match(/(?:勤務時間|シフト)\s*[:：]?\s*([^\n]+)/i);
    hours=m?t(m[1],180):(t(sub?.hours,180)||"応相談");
  }

  let contact=t(sub?.job_contact,500);
  if(!contact){
    contact=kbnExtractLabeledValue(text,["応募先","応募方法","連絡先","問い合わせ先"],500);
  }
  if(!contact){
    contact=t(sub?.email||sub?.phone||sub?.instagram||"",500);
  }

  let description=t(sub?.job_description,5000);
  if(!description){
    // 備考・説明に求人情報が含まれている場合、その内容を求人本文にそのまま活用
    const candidate=[sub?.note,sub?.description,sub?.features].filter(Boolean).join("\n\n").trim();
    description=t(candidate,5000)||"詳しい募集内容は店舗へお問い合わせください。";
  }

  return {title,employment,salary,hours,description,contact};
}

async function publishJobFromSubmission(env,sub,shopId){
  if(!shopId || !kbnJobIntentFromSubmission(sub)){
    return {ok:true,created:false,reason:"NO_JOB_INTENT"};
  }

  const job=kbnExtractJobData(sub);
  const {title,employment,salary,hours,description,contact}=job;

  // 同じ店舗に同名の求人がある場合は重複作成せず更新
  const existing=await env.DB.prepare(`
    SELECT id FROM jobs
    WHERE shop_id=? AND title=?
    ORDER BY id DESC LIMIT 1
  `).bind(shopId,title).first();

  if(existing?.id){
    await env.DB.prepare(`
      UPDATE jobs SET
        employment_type=?,salary=?,hours=?,description=?,contact=?,
        is_published=1,sort_order=100,updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).bind(
      employment,salary,hours,description,contact,Number(existing.id)
    ).run();
    return {
      ok:true,created:false,updated:true,job_id:Number(existing.id),
      auto_detected:!b(sub?.wants_job),extracted:job
    };
  }

  const r=await env.DB.prepare(`
    INSERT INTO jobs (
      shop_id,title,employment_type,salary,hours,description,contact,is_published,sort_order
    ) VALUES (?,?,?,?,?,?,?,1,100)
  `).bind(
    shopId,title,employment,salary,hours,description,contact
  ).run();

  return {
    ok:true,created:true,job_id:Number(r.meta?.last_row_id||0),
    auto_detected:!b(sub?.wants_job),extracted:job
  };
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




// ============================================================
// KBN FREE MEMBER v1.90
// Free registration / login / favorites sync / new-listing email opt-in
// ============================================================
const KBN_MEMBER_COOKIE="kbn_member_session";
const KBN_MEMBER_SESSION_DAYS=30;
const KBN_MEMBER_PBKDF2_ITERATIONS=100000;

function kbnMemberJson(data,status=200,headers={}){
  return json(data,{status,headers});
}
function kbnMemberEmail(v){
  return String(v||"").trim().toLowerCase().slice(0,254);
}
function kbnMemberName(v){
  return String(v||"").trim().slice(0,80);
}
function kbnRandomToken(bytes=32){
  const a=new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a,b=>b.toString(16).padStart(2,"0")).join("");
}
function kbnBytesToBase64(bytes){
  let s="";
  for(const b of bytes)s+=String.fromCharCode(b);
  return btoa(s);
}
function kbnBase64ToBytes(s){
  const bin=atob(String(s||""));
  return Uint8Array.from(bin,c=>c.charCodeAt(0));
}
async function kbnHashPassword(password,saltB64=""){
  const passwordText=String(password||"");
  const salt=saltB64?kbnBase64ToBytes(saltB64):crypto.getRandomValues(new Uint8Array(16));
  const key=await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passwordText),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits=await crypto.subtle.deriveBits(
    {name:"PBKDF2",salt,iterations:KBN_MEMBER_PBKDF2_ITERATIONS,hash:"SHA-256"},
    key,
    256
  );
  return {
    salt:kbnBytesToBase64(salt),
    hash:kbnBytesToBase64(new Uint8Array(bits))
  };
}
function kbnSafeEqual(a,b){
  const x=String(a||""),y=String(b||"");
  if(x.length!==y.length)return false;
  let diff=0;
  for(let i=0;i<x.length;i++)diff|=x.charCodeAt(i)^y.charCodeAt(i);
  return diff===0;
}
function kbnCookieValue(request,name){
  const raw=String(request.headers.get("Cookie")||"");
  for(const part of raw.split(";")){
    const [k,...rest]=part.trim().split("=");
    if(k===name)return decodeURIComponent(rest.join("="));
  }
  return "";
}
function kbnSessionCookie(token,maxAge=KBN_MEMBER_SESSION_DAYS*86400){
  return `${KBN_MEMBER_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
function kbnClearSessionCookie(){
  return `${KBN_MEMBER_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
async function ensureKbnMemberSchema(env){
  // D1では複数CREATEを1回のexecにまとめず、1テーブルずつ確実に作成する。
  // 外部キー制約に依存せず、既存DBとの互換性を優先。
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS members(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      display_name TEXT,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      email_notifications INTEGER NOT NULL DEFAULT 1,
      unsubscribe_token TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_login_at TEXT
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS member_sessions(
      token TEXT PRIMARY KEY,
      member_id INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS member_favorites(
      member_id INTEGER NOT NULL,
      shop_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(member_id,shop_id)
    )
  `).run();

  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_member_sessions_member
    ON member_sessions(member_id)
  `).run();

  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_member_favorites_member
    ON member_favorites(member_id)
  `).run();
}
async function kbnCurrentMember(env,request){
  await ensureKbnMemberSchema(env);
  const token=kbnCookieValue(request,KBN_MEMBER_COOKIE);
  if(!token)return null;
  const row=await env.DB.prepare(`
    SELECT m.id,m.email,m.display_name,m.email_notifications,m.status,
           s.token,s.expires_at
    FROM member_sessions s
    JOIN members m ON m.id=s.member_id
    WHERE s.token=? AND m.status='active'
      AND datetime(s.expires_at)>datetime('now')
    LIMIT 1
  `).bind(token).first();
  if(!row)return null;
  return {
    id:Number(row.id),
    email:String(row.email||""),
    display_name:String(row.display_name||""),
    email_notifications:Number(row.email_notifications||0)===1
  };
}
async function kbnCreateMemberSession(env,memberId){
  const token=kbnRandomToken(32);
  await env.DB.prepare(`
    DELETE FROM member_sessions
    WHERE member_id=? AND datetime(expires_at)<=datetime('now')
  `).bind(memberId).run();
  await env.DB.prepare(`
    INSERT INTO member_sessions(token,member_id,expires_at)
    VALUES(?,?,datetime('now','+30 days'))
  `).bind(token,memberId).run();
  return token;
}
function kbnPublicMember(m){
  if(!m)return null;
  return {
    id:Number(m.id),
    email:String(m.email||""),
    display_name:String(m.display_name||""),
    email_notifications:!!m.email_notifications
  };
}
async function kbnSendMemberWelcome(env,member){
  if(!env.RESEND_API_KEY)return {ok:false,error:"RESEND_API_KEY_NOT_BOUND"};
  const from=String(env.MAIL_FROM||"KUMAMOTO BAR NAVI <noreply@kumamoto-bar-navi.com>");
  const unsub=`https://kumamoto-bar-navi.rrwpvwmz8p.workers.dev/api/member/unsubscribe?token=${encodeURIComponent(member.unsubscribe_token||"")}`;
  const body={
    from,
    to:[member.email],
    subject:"BARナビ 無料会員登録ありがとうございます",
    html:`
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.8;color:#161616">
        <h2>BARナビへようこそ🍸</h2>
        <p>${escHtml(member.display_name||"")}さん、無料会員登録ありがとうございます。</p>
        <p>お気に入りBARをアカウントに保存できるようになりました。</p>
        ${Number(member.email_notifications||0)===1?`<p>新しく掲載されたBAR情報もメールでお届けします。</p>`:""}
        <p><a href="https://kumamoto-bar-navi.rrwpvwmz8p.workers.dev/member.html">マイページを開く</a></p>
        ${Number(member.email_notifications||0)===1?`<p style="font-size:12px;color:#777"><a href="${unsub}">新着メールを配信停止</a></p>`:""}
      </div>`
  };
  const r=await fetch("https://api.resend.com/emails",{
    method:"POST",
    headers:{
      "Authorization":`Bearer ${env.RESEND_API_KEY}`,
      "Content-Type":"application/json"
    },
    body:JSON.stringify(body)
  });
  return {ok:r.ok,status:r.status};
}
async function kbnSendNewListingDigest(env,created=[]){
  if(!env.RESEND_API_KEY)return {ok:false,error:"RESEND_API_KEY_NOT_BOUND"};
  const shops=(Array.isArray(created)?created:[]).slice(0,15);
  if(!shops.length)return {ok:true,sent:0};

  await ensureKbnMemberSchema(env);
  const result=await env.DB.prepare(`
    SELECT id,email,display_name,unsubscribe_token
    FROM members
    WHERE status='active' AND email_notifications=1
    ORDER BY id ASC
    LIMIT 500
  `).all();
  const members=result.results||[];
  if(!members.length)return {ok:true,sent:0};

  const from=String(env.MAIL_FROM||"KUMAMOTO BAR NAVI <noreply@kumamoto-bar-navi.com>");
  const shopRows=shops.map(s=>{
    const name=escHtml(String(s.name||"").replace(/^【KBN独自掲載】/,"").trim());
    const slug=encodeURIComponent(String(s.slug||""));
    return `<li style="margin:8px 0"><a href="https://kumamoto-bar-navi.rrwpvwmz8p.workers.dev/shop?slug=${slug}">${name}</a></li>`;
  }).join("");

  let sent=0,failed=0;
  for(const m of members){
    const unsub=`https://kumamoto-bar-navi.rrwpvwmz8p.workers.dev/api/member/unsubscribe?token=${encodeURIComponent(m.unsubscribe_token||"")}`;
    try{
      const r=await fetch("https://api.resend.com/emails",{
        method:"POST",
        headers:{
          "Authorization":`Bearer ${env.RESEND_API_KEY}`,
          "Content-Type":"application/json"
        },
        body:JSON.stringify({
          from,
          to:[m.email],
          subject:`BARナビ 新着BAR ${shops.length}店舗を掲載しました`,
          html:`
            <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.8;color:#161616">
              <h2>新しいBARが掲載されました🍸</h2>
              <p>${escHtml(m.display_name||"")}さん、BARナビの新着店舗です。</p>
              <ul>${shopRows}</ul>
              <p><a href="https://kumamoto-bar-navi.rrwpvwmz8p.workers.dev/bars.html">BARをもっと探す</a></p>
              <p style="font-size:12px;color:#777"><a href="${unsub}">新着メールを配信停止</a></p>
            </div>`
        })
      });
      if(r.ok)sent++; else failed++;
    }catch{failed++}
  }
  return {ok:true,sent,failed};
}

// v2.96: LCP/mobile performance boost.
const KBN_LOGO_192_PNG_B64="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";
function kbnLogo192PngBytesV296(){
  const raw=atob(KBN_LOGO_192_PNG_B64);
  const out=new Uint8Array(raw.length);
  for(let i=0;i<raw.length;i++)out[i]=raw.charCodeAt(i);
  return out;
}

// v2.78: SEO専用ページ・コラム・エリアSEOページをサイト更新から更新可能にする
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
  "areas.html",
  "robots.txt",
  "sitemap.xml",
  "member.html",
  "listing-form.html",
  "kumamoto-bar.html",
  "shimotori-bar.html",
  "karaoke-bar-kumamoto.html",
  "darts-bar-kumamoto.html",
  "snack-kumamoto.html",
  "column-bar-beginner.html",
  "column-kumamoto-night.html",
  "column-solo-bar.html",
  "kumamoto-station-bar.html",
  "suizenji-bar.html",
  "kengun-bar.html",
  "hikarinomori-bar.html",
  "yatsushiro-bar.html",
  "hitoyoshi-bar.html",
  "tamana-bar.html",
  "amakusa-bar.html"
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


function kbnNormalizeJstTime(value){
  const m=String(value||"").trim().match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if(!m)return "";
  return `${m[1]}:${m[2]}`;
}

function kbnJstTimeToCron(value){
  const time=kbnNormalizeJstTime(value);
  if(!time)return "";
  const [h,m]=time.split(":").map(Number);
  const utcMinutes=(h*60+m-9*60+24*60)%(24*60);
  const uh=Math.floor(utcMinutes/60);
  const um=utcMinutes%60;
  return `${um} ${uh} * * *`;
}


function kbnHomeHeroLivePatchScriptV245(){
  return `<script>(function(){
    function txt(el){return String(el?.innerText||el?.textContent||"").replace(/\s+/g," ").trim();}
    function jpTime(){
      try{
        return new Date().toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false,timeZone:'Asia/Tokyo'});
      }catch(_){
        const d=new Date();
        return [d.getHours(),d.getMinutes(),d.getSeconds()].map(v=>String(v).padStart(2,'0')).join(':');
      }
    }
    function injectStyle(){
      if(document.getElementById('kbn-live-hero-style-v245')) return;
      const style=document.createElement('style');
      style.id='kbn-live-hero-style-v245';
      style.textContent = [
        '.kbn-live-hero-wrap-v245{position:relative;gap:12px!important;margin:14px 0 18px!important}',
        '.kbn-live-hero-wrap-v245::before{content:"";position:absolute;inset:-6px;border-radius:28px;background:radial-gradient(circle at 20% 20%,rgba(228,190,85,.12),transparent 42%),radial-gradient(circle at 80% 30%,rgba(255,255,255,.06),transparent 35%);pointer-events:none}',
        '.kbn-live-card-v245{position:relative;overflow:hidden;padding:14px 16px!important;min-height:0!important;border-radius:20px!important;background:linear-gradient(135deg,rgba(7,19,40,.98),rgba(19,27,47,.92))!important;border:1px solid rgba(228,190,85,.28)!important;box-shadow:0 10px 28px rgba(0,0,0,.22),inset 0 1px 0 rgba(255,255,255,.04)!important}',
        '.kbn-live-card-v245::after{content:"";position:absolute;inset:auto -20% -55% auto;width:160px;height:160px;border-radius:999px;background:radial-gradient(circle,rgba(228,190,85,.22),rgba(228,190,85,0));pointer-events:none}',
        '.kbn-live-head-v245{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px}',
        '.kbn-live-badge-v245{display:inline-flex;align-items:center;gap:6px;padding:4px 9px;border-radius:999px;background:rgba(12,20,34,.72);border:1px solid rgba(106,232,170,.34);color:#b8ffd6;font-size:10px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;white-space:nowrap}',
        '.kbn-live-dot-v245{width:8px;height:8px;border-radius:50%;background:#61f2a6;box-shadow:0 0 0 0 rgba(97,242,166,.45);animation:kbnLivePulseV245 1.8s infinite}',
        '@keyframes kbnLivePulseV245{0%{box-shadow:0 0 0 0 rgba(97,242,166,.48)}70%{box-shadow:0 0 0 10px rgba(97,242,166,0)}100%{box-shadow:0 0 0 0 rgba(97,242,166,0)}}',
        '.kbn-live-label-v245{font-size:11px!important;line-height:1.25!important;letter-spacing:.08em;color:rgba(255,230,170,.96)!important;font-weight:700!important;text-transform:none}',
        '.kbn-live-sub-v245{font-size:11px!important;line-height:1.35!important;color:rgba(214,224,238,.70)!important;margin-top:2px}',
        '.kbn-live-number-v245{font-size:clamp(26px,7.1vw,42px)!important;line-height:1!important;font-weight:900!important;letter-spacing:-.03em;text-shadow:0 0 18px rgba(255,209,95,.16)}',
        '.kbn-live-meta-v245{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,.08);font-size:10px;color:rgba(230,238,247,.72)}',
        '.kbn-live-clock-v245{font-variant-numeric:tabular-nums;color:#9ef3c0;font-weight:700;letter-spacing:.08em}'
      ].join('');
      document.head.appendChild(style);
    }
    function findLabel(label){
      return Array.from(document.querySelectorAll('body *')).find(el=>{
        if(!el) return false;
        const t=txt(el);
        if(!t) return false;
        if(t!==label && !t.startsWith(label)) return false;
        return (el.children?.length||0) <= 6;
      }) || null;
    }
    function findCard(node){
      let cur=node;
      while(cur && cur!==document.body){
        const t=txt(cur);
        const tag=(cur.tagName||'').toLowerCase();
        if(['div','article','section','li'].includes(tag) && /\d/.test(t) && t.length<=220){
          return cur;
        }
        cur=cur.parentElement;
      }
      return node?.parentElement || null;
    }
    function isVisible(el){
      if(!el) return false;
      const st=getComputedStyle(el);
      return st.display!=='none' && st.visibility!=='hidden';
    }
    function findNumberEl(card){
      const all=Array.from(card.querySelectorAll('*')).filter(isVisible);
      let best=null,bestScore=-1;
      for(const el of all){
        const t=txt(el);
        if(!t || !/\d/.test(t)) continue;
        const rect=el.getBoundingClientRect();
        const score=(rect.width*rect.height) + (t.includes('店舗')||t.includes('地域')?5000:0) + (/^\d+$/.test(t.replace(/,/g,''))?8000:0);
        if(score>bestScore){best=el;bestScore=score;}
      }
      return best;
    }
    function findSubEl(card,labelEl,numberEl){
      return Array.from(card.querySelectorAll('*')).find(el=>{
        if(el===labelEl || el===numberEl) return false;
        const t=txt(el);
        return t && (t.includes('随時更新') || t.includes('エリアをカバー') || t.length<=26);
      }) || null;
    }
    function patchCard(card,label){
      if(!card || card.dataset.kbnLiveHeroStatV245==='1') return;
      card.dataset.kbnLiveHeroStatV245='1';
      card.classList.add('kbn-live-card-v245');
      const numberEl=findNumberEl(card);
      const labelEl=findLabel(label) || Array.from(card.querySelectorAll('*')).find(el=>txt(el).includes(label));
      const subEl=findSubEl(card,labelEl,numberEl);
      if(numberEl) numberEl.classList.add('kbn-live-number-v245');
      if(labelEl) labelEl.classList.add('kbn-live-label-v245');
      if(subEl) subEl.classList.add('kbn-live-sub-v245');
      const head=document.createElement('div');
      head.className='kbn-live-head-v245';
      const badge=document.createElement('div');
      badge.className='kbn-live-badge-v245';
      badge.innerHTML='<span class="kbn-live-dot-v245"></span>LIVE';
      if(labelEl && labelEl.parentElement){
        labelEl.parentElement.insertBefore(head,labelEl);
        head.appendChild(labelEl);
        head.appendChild(badge);
      }else{
        card.insertBefore(head,card.firstChild);
        const fallback=document.createElement('div');
        fallback.className='kbn-live-label-v245';
        fallback.textContent=label;
        head.appendChild(fallback);
        head.appendChild(badge);
      }
      if(!subEl){
        const p=document.createElement('div');
        p.className='kbn-live-sub-v245';
        p.textContent=label==='掲載店舗数' ? '熊本県内のBAR情報をリアルタイム表示' : '県内の対応エリアをリアルタイム表示';
        if(numberEl?.parentElement) numberEl.parentElement.insertAdjacentElement('afterend',p);
        else card.appendChild(p);
      }
      const meta=document.createElement('div');
      meta.className='kbn-live-meta-v245';
      meta.innerHTML='<span>リアルタイム更新中</span><span class="kbn-live-clock-v245"></span>';
      card.appendChild(meta);
    }
    function patchWrap(){
      const wrap=Array.from(document.querySelectorAll('section,div,article')).find(el=>{
        const t=txt(el);
        return t.includes('掲載店舗数') && t.includes('対応エリア') && (el.querySelectorAll('div,article,section').length>=2);
      });
      if(wrap) wrap.classList.add('kbn-live-hero-wrap-v245');
      return wrap;
    }
    function updateClocks(){
      const now=jpTime();
      document.querySelectorAll('.kbn-live-clock-v245').forEach(el=>{el.textContent=now;});
    }
    function apply(){
      injectStyle();
      patchWrap();
      const shopCard=findCard(findLabel('掲載店舗数'));
      const areaCard=findCard(findLabel('対応エリア'));
      patchCard(shopCard,'掲載店舗数');
      patchCard(areaCard,'対応エリア');
      updateClocks();
    }
    function run(){
      apply();
      setTimeout(apply,200);
      setTimeout(apply,1200);
      setInterval(updateClocks,1000);
    }
    if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',run,{once:true});
    else run();
    const mo=new MutationObserver(()=>apply());
    mo.observe(document.documentElement,{childList:true,subtree:true});
    setTimeout(()=>mo.disconnect(),15000);
  })();</script>`;
}

function kbnInjectHomeHeroLiveV245(html){
  // LIVE表示は index.html 側で管理。対応エリアへ旧LIVE演出を再注入しない。
  return String(html||'');
}

function kbnCronToJstTime(cron){
  const m=String(cron||"").trim().match(/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/);
  if(!m)return "";
  const minute=Number(m[1]),hour=Number(m[2]);
  if(minute<0||minute>59||hour<0||hour>23)return "";
  const jstMinutes=(hour*60+minute+9*60)%(24*60);
  const jh=Math.floor(jstMinutes/60);
  const jm=jstMinutes%60;
  return `${String(jh).padStart(2,"0")}:${String(jm).padStart(2,"0")}`;
}

function kbnSortJstTimes(times){
  return [...times].sort((a,b)=>{
    const [ah,am]=a.split(":").map(Number);
    const [bh,bm]=b.split(":").map(Number);
    return ah*60+am-(bh*60+bm);
  });
}

function kbnCompileDailyCronsV218(timesJst){
  const groups=new Map();
  for(const time of timesJst){
    const normalized=kbnNormalizeJstTime(time);
    if(!normalized)continue;
    const [jh,jm]=normalized.split(":").map(Number);
    const uh=(jh+24-9)%24;
    const key=jm;
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(uh);
  }
  return [...groups.entries()]
    .sort((a,b)=>a[0]-b[0])
    .map(([minute,hours])=>{
      const hs=[...new Set(hours)].sort((a,b)=>a-b).join(",");
      return `${minute} ${hs} * * *`;
    });
}

function kbnScheduledJstTimeV218(event){
  const ms=Number(event?.scheduledTime||Date.now());
  const d=new Date(ms+9*60*60*1000);
  return `${String(d.getUTCHours()).padStart(2,"0")}:${String(d.getUTCMinutes()).padStart(2,"0")}`;
}

function kbnMaintenanceTimeJstV218(env){
  const direct=kbnNormalizeJstTime(env?.KBN_FULL_MAINTENANCE_TIME_JST);
  if(direct)return direct;
  return KBN_DEFAULT_FULL_MAINTENANCE_TIMES_JST_V215[0]||"00:00";
}

function kbnIsFullMaintenanceEventV218(env,event){
  return kbnScheduledJstTimeV218(event)===kbnMaintenanceTimeJstV218(env);
}

// KBN v2.18: Cloudflare FreeのCron上限(5/account)に対応。6回の時刻をCron式へまとめて保存。
const KBN_DEFAULT_AUTO_LISTING_TIMES_JST_V217=["00:00","03:00","06:00","09:00","12:00","18:00"];
const KBN_DEFAULT_FULL_MAINTENANCE_TIMES_JST_V215=["00:00"];

function kbnFullMaintenanceCrons(env){
  const raw=String(env?.KBN_FULL_MAINTENANCE_CRONS||"").trim();
  const list=raw.split("|").map(x=>x.trim()).filter(Boolean);
  if(list.length===1)return list;
  return KBN_DEFAULT_FULL_MAINTENANCE_TIMES_JST_V215.map(kbnJstTimeToCron);
}

function kbnConfiguredAutoOnlyCrons(env){
  const raw=String(env?.KBN_AUTO_ONLY_CRONS||"").trim();
  const list=raw.split("|").map(x=>x.trim()).filter(Boolean);
  if(list.length===5)return list;

  const full=new Set(kbnFullMaintenanceCrons(env));
  return KBN_DEFAULT_AUTO_LISTING_TIMES_JST_V217
    .map(kbnJstTimeToCron)
    .filter(cron=>!full.has(cron));
}

function kbnAutoListingCrons(env){
  return [...kbnFullMaintenanceCrons(env),...kbnConfiguredAutoOnlyCrons(env)];
}

function kbnIsFullMaintenanceCron(env,cron){
  return new Set(kbnFullMaintenanceCrons(env)).has(String(cron||"").trim());
}

async function kbnReadWranglerFromGithub(env){
  const c=kbnGithubConfig(env);
  const d=await kbnGithubApi(
    env,
    `/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/contents/wrangler.jsonc?ref=${encodeURIComponent(c.branch)}`
  );
  if(Array.isArray(d)||d.type!=="file")throw new Error("WRANGLER_NOT_A_FILE");
  const content=kbnBase64ToUtf8(d.content||"");
  let config;
  try{config=JSON.parse(content)}
  catch{throw new Error("WRANGLER_JSON_PARSE_FAILED")}
  return {config,sha:d.sha,content,c};
}

async function kbnUpdateAutoSchedule(env,scheduleInput){
  const listingRaw=Array.isArray(scheduleInput?.auto_listing_times_jst)
    ?scheduleInput.auto_listing_times_jst
    :(Array.isArray(scheduleInput)?scheduleInput:[]);
  const maintenanceRaw=String(
    scheduleInput?.full_maintenance_time_jst
    ||scheduleInput?.maintenance_time_jst
    ||""
  ).trim();

  const listingTimes=listingRaw.map(kbnNormalizeJstTime);
  const maintenanceTime=kbnNormalizeJstTime(maintenanceRaw);

  if(listingTimes.length!==6||listingTimes.some(x=>!x)){
    const e=new Error("AUTO_LISTING_REQUIRES_6_VALID_JST_TIMES");
    e.status=400;
    throw e;
  }
  if(new Set(listingTimes).size!==6){
    const e=new Error("AUTO_LISTING_TIMES_MUST_BE_UNIQUE");
    e.status=400;
    throw e;
  }
  if(!maintenanceTime){
    const e=new Error("MAINTENANCE_TIME_REQUIRED");
    e.status=400;
    throw e;
  }
  if(!listingTimes.includes(maintenanceTime)){
    const e=new Error("MAINTENANCE_TIME_MUST_MATCH_ONE_AUTO_LISTING_TIME");
    e.status=400;
    throw e;
  }

  const sortedListingTimes=kbnSortJstTimes(listingTimes);
  const autoOnlyTimes=sortedListingTimes.filter(x=>x!==maintenanceTime);
  const crons=kbnCompileDailyCronsV218(sortedListingTimes);
  if(crons.length>5){
    const e=new Error("CLOUDFLARE_FREE_CRON_LIMIT_5_DISTINCT_MINUTES");
    e.status=400;
    throw e;
  }
  const fullCrons=[kbnJstTimeToCron(maintenanceTime)];
  const autoOnlyCrons=autoOnlyTimes.map(kbnJstTimeToCron);

  const {config,sha,c}=await kbnReadWranglerFromGithub(env);
  config.triggers=config.triggers&&typeof config.triggers==="object"?config.triggers:{};
  config.triggers.crons=crons;
  config.vars=config.vars&&typeof config.vars==="object"?config.vars:{};
  config.vars.KBN_CONFIG_VERSION="2.29";
  config.vars.KBN_FULL_MAINTENANCE_CRONS=fullCrons.join("|");
  config.vars.KBN_FULL_MAINTENANCE_TIME_JST=maintenanceTime;
  config.vars.KBN_AUTO_ONLY_CRONS=autoOnlyCrons.join("|");
  config.vars.KBN_AUTO_LISTING_TIMES_JST=sortedListingTimes.join("|");
  config.vars.KBN_SCHEDULE_UPDATED_AT=new Date().toISOString();

  const content=JSON.stringify(config,null,2)+"\n";
  const result=await kbnGithubApi(
    env,
    `/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/contents/wrangler.jsonc`,
    {
      method:"PUT",
      headers:{"content-type":"application/json"},
      body:JSON.stringify({
        message:`admin: set auto listing ${sortedListingTimes.join(" / ")} JST; maintenance ${maintenanceTime} (v2.29 receipt monitor)`,
        content:kbnUtf8ToBase64(content),
        sha,
        branch:c.branch
      })
    }
  );

  return {
    ok:true,
    timezone:"Asia/Tokyo",
    times_jst:[maintenanceTime],
    full_maintenance_times_jst:[maintenanceTime],
    full_maintenance_time_jst:maintenanceTime,
    auto_only_times_jst:autoOnlyTimes,
    auto_listing_times_jst:sortedListingTimes,
    crons,
    commit_sha:result.commit?.sha||"",
    commit_url:result.commit?.html_url||"",
    message:"自動掲載6回と通常メンテナンス1回の時間をGitHubへ反映しました。Cloudflareの自動デプロイ後に有効になります。"
  };
}




async function ensureKbnRuntimeScheduleTableV230(env){
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS kbn_runtime_schedule(
      id INTEGER PRIMARY KEY,
      times_json TEXT NOT NULL,
      maintenance_time TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS kbn_runtime_minute_runs(
      minute_key TEXT PRIMARY KEY,
      run_type TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
}

function kbnValidateRuntimeScheduleV230(scheduleInput){
  const listingRaw=Array.isArray(scheduleInput?.auto_listing_times_jst)
    ?scheduleInput.auto_listing_times_jst:[];
  const listingTimes=listingRaw.map(kbnNormalizeJstTime);
  const maintenanceTime=kbnNormalizeJstTime(
    scheduleInput?.full_maintenance_time_jst||scheduleInput?.maintenance_time_jst||""
  );
  if(listingTimes.length!==6||listingTimes.some(x=>!x)){
    const e=new Error("AUTO_LISTING_REQUIRES_6_VALID_JST_TIMES"); e.status=400; throw e;
  }
  if(new Set(listingTimes).size!==6){
    const e=new Error("AUTO_LISTING_TIMES_MUST_BE_UNIQUE"); e.status=400; throw e;
  }
  if(!maintenanceTime||!listingTimes.includes(maintenanceTime)){
    const e=new Error("MAINTENANCE_TIME_MUST_MATCH_ONE_AUTO_LISTING_TIME"); e.status=400; throw e;
  }
  return {auto_listing_times_jst:kbnSortJstTimes(listingTimes),full_maintenance_time_jst:maintenanceTime};
}

async function kbnGetRuntimeScheduleV230(env){
  await ensureKbnRuntimeScheduleTableV230(env);
  const row=await env.DB.prepare(`SELECT times_json,maintenance_time,updated_at FROM kbn_runtime_schedule WHERE id=1`).first();
  if(row){
    try{
      const parsed=JSON.parse(String(row.times_json||"[]"));
      return {...kbnValidateRuntimeScheduleV230({auto_listing_times_jst:parsed,full_maintenance_time_jst:row.maintenance_time}),updated_at:String(row.updated_at||"")};
    }catch(e){console.error("runtime schedule parse failed",e)}
  }
  const fallback=kbnEffectiveScheduleV224(env);
  return {
    auto_listing_times_jst:fallback.auto_listing_times_jst,
    full_maintenance_time_jst:fallback.full_maintenance_time_jst,
    updated_at:"",
    source:"fallback"
  };
}

async function kbnSaveRuntimeScheduleV230(env,scheduleInput){
  const valid=kbnValidateRuntimeScheduleV230(scheduleInput);
  await ensureKbnRuntimeScheduleTableV230(env);
  await env.DB.prepare(`
    INSERT INTO kbn_runtime_schedule(id,times_json,maintenance_time,updated_at)
    VALUES(1,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET times_json=excluded.times_json,maintenance_time=excluded.maintenance_time,updated_at=CURRENT_TIMESTAMP
  `).bind(JSON.stringify(valid.auto_listing_times_jst),valid.full_maintenance_time_jst).run();
  return {...valid,timezone:"Asia/Tokyo"};
}

function kbnJstMinuteKeyV230(event){
  const ms=Number(event?.scheduledTime||Date.now());
  const d=new Date(ms+9*60*60*1000);
  const yyyy=d.getUTCFullYear();
  const mm=String(d.getUTCMonth()+1).padStart(2,"0");
  const dd=String(d.getUTCDate()).padStart(2,"0");
  const hh=String(d.getUTCHours()).padStart(2,"0");
  const mi=String(d.getUTCMinutes()).padStart(2,"0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}


function kbnJstDatePartsV231(event){
  const ms=Number(event?.scheduledTime||Date.now());
  const d=new Date(ms+9*60*60*1000);
  return {
    yyyy:d.getUTCFullYear(),
    mm:String(d.getUTCMonth()+1).padStart(2,"0"),
    dd:String(d.getUTCDate()).padStart(2,"0"),
    hh:d.getUTCHours(),
    mi:d.getUTCMinutes()
  };
}

function kbnFindDueRuntimeSlotV231(event,schedule,graceMinutes=30){
  const p=kbnJstDatePartsV231(event);
  const nowMinutes=p.hh*60+p.mi;
  const times=Array.isArray(schedule?.auto_listing_times_jst)?schedule.auto_listing_times_jst:[];
  let best=null;

  for(const raw of times){
    const m=String(raw||"").match(/^(\d{2}):(\d{2})$/);
    if(!m)continue;
    const h=Number(m[1]), mi=Number(m[2]);
    const slotMinutes=h*60+mi;
    const diff=nowMinutes-slotMinutes;

    // v2.31: 設定時刻ちょうどだけでなく、30分以内なら取りこぼした回を救済する。
    if(diff<0 || diff>graceMinutes)continue;
    if(!best || diff<best.diff){
      best={
        time:`${String(h).padStart(2,"0")}:${String(mi).padStart(2,"0")}`,
        diff,
        minute_key:`${p.yyyy}-${p.mm}-${p.dd} ${String(h).padStart(2,"0")}:${String(mi).padStart(2,"0")}`
      };
    }
  }
  return best;
}

async function kbnClaimRuntimeSlotV231(env,minuteKey,runType){
  await ensureKbnRuntimeScheduleTableV230(env);
  const r=await env.DB.prepare(
    `INSERT OR IGNORE INTO kbn_runtime_minute_runs(minute_key,run_type,created_at)
     VALUES(?,?,CURRENT_TIMESTAMP)`
  ).bind(String(minuteKey),String(runType||"auto_listing")).run();
  return Number(r?.meta?.changes||0)>0;
}

async function kbnClaimRuntimeMinuteV230(env,event,runType){
  await ensureKbnRuntimeScheduleTableV230(env);
  const key=kbnJstMinuteKeyV230(event);
  const r=await env.DB.prepare(`INSERT OR IGNORE INTO kbn_runtime_minute_runs(minute_key,run_type,created_at) VALUES(?,?,CURRENT_TIMESTAMP)`).bind(key,String(runType||"auto_listing")).run();
  return Number(r?.meta?.changes||0)>0;
}

async function kbnEnsureMinuteCronPermanentV230(env){
  const fixed=["* * * * *"];
  let cloudflare={ok:false,error:""};
  try{cloudflare=await kbnCloudflareSetSchedulesV225(env,fixed)}
  catch(e){cloudflare={ok:false,error:String(e?.message||e)}}

  // GitHubのwranglerも「毎分1回」に一度だけ固定。以後、時間変更ではデプロイ不要。
  let github={ok:true,changed:false,error:""};
  try{
    const {config,sha,c}=await kbnReadWranglerFromGithub(env);
    const current=Array.isArray(config?.triggers?.crons)?config.triggers.crons:[];
    if(current.length!==1||String(current[0]).trim()!==fixed[0]){
      config.triggers=config.triggers&&typeof config.triggers==="object"?config.triggers:{};
      config.triggers.crons=fixed;
      config.vars=config.vars&&typeof config.vars==="object"?config.vars:{};
      config.vars.KBN_CONFIG_VERSION="2.42";
      const content=JSON.stringify(config,null,2)+"\n";
      const result=await kbnGithubApi(env,`/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/contents/wrangler.jsonc`,{
        method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({
          message:"admin: switch KBN scheduler to fixed every-minute trigger (v2.42)",
          content:kbnUtf8ToBase64(content),sha,branch:c.branch
        })
      });
      github={ok:true,changed:true,commit_sha:result.commit?.sha||""};
    }
  }catch(e){github={ok:false,changed:false,error:String(e?.message||e)}}
  return {cloudflare,github,cron:fixed[0]};
}

async function ensureKbnCronReceiptsTableV229(env){
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS kbn_cron_receipts(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scheduled_time TEXT,
      scheduled_jst TEXT,
      cron_expression TEXT,
      received_at TEXT DEFAULT CURRENT_TIMESTAMP,
      handler_version TEXT,
      note TEXT
    )
  `).run();
}

async function kbnCronReceiptV229(env,event,note="received"){
  await ensureKbnCronReceiptsTableV229(env);
  const scheduledMs=Number(event?.scheduledTime||Date.now());
  const scheduledIso=new Date(scheduledMs).toISOString();
  const scheduledJst=kbnScheduledJstTimeV218(event);
  const cronExpression=String(event?.cron||"");
  await env.DB.prepare(`
    INSERT INTO kbn_cron_receipts(
      scheduled_time,scheduled_jst,cron_expression,received_at,handler_version,note
    ) VALUES(?,?,?,CURRENT_TIMESTAMP,'2.29',?)
  `).bind(scheduledIso,scheduledJst,cronExpression,String(note||"received")).run();
}

async function kbnLastCronReceiptV229(env){
  await ensureKbnCronReceiptsTableV229(env);
  return await env.DB.prepare(`
    SELECT id,scheduled_time,scheduled_jst,cron_expression,received_at,handler_version,note
    FROM kbn_cron_receipts
    ORDER BY id DESC LIMIT 1
  `).first();
}

function kbnSchedulePropagationStateV229(updatedAt){
  const raw=String(updatedAt||"").trim();
  if(!raw)return {within_window:false,minutes_since:null};
  const ms=Date.parse(raw);
  if(!Number.isFinite(ms))return {within_window:false,minutes_since:null};
  const minutes=Math.max(0,(Date.now()-ms)/60000);
  return {
    within_window:minutes<15,
    minutes_since:Math.round(minutes*10)/10,
    ready_after_iso:new Date(ms+15*60000).toISOString()
  };
}

async function ensureKbnCronRunsTableV224(env){
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS kbn_cron_runs(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scheduled_time TEXT,
      scheduled_jst TEXT,
      run_type TEXT NOT NULL,
      status TEXT NOT NULL,
      created_count INTEGER DEFAULT 0,
      error TEXT,
      diagnostic_json TEXT,
      started_at TEXT DEFAULT CURRENT_TIMESTAMP,
      finished_at TEXT
    )
  `).run();
  try{await env.DB.prepare("ALTER TABLE kbn_cron_runs ADD COLUMN diagnostic_json TEXT").run()}catch{}
}

async function kbnCronRunStartV224(env,event,runType){
  await ensureKbnCronRunsTableV224(env);
  const scheduledMs=Number(event?.scheduledTime||Date.now());
  const scheduledIso=new Date(scheduledMs).toISOString();
  const scheduledJst=kbnScheduledJstTimeV218(event);
  const r=await env.DB.prepare(`
    INSERT INTO kbn_cron_runs(scheduled_time,scheduled_jst,run_type,status,created_count,started_at)
    VALUES(?,?,?,'running',0,CURRENT_TIMESTAMP)
  `).bind(scheduledIso,scheduledJst,String(runType||"auto")).run();
  return Number(r?.meta?.last_row_id||0);
}

async function kbnCronRunFinishV224(env,id,{status="success",createdCount=0,error="",diagnostic=null}={}){
  if(!id)return;
  await ensureKbnCronRunsTableV224(env);
  const diag=diagnostic?JSON.stringify(diagnostic).slice(0,12000):"";
  await env.DB.prepare(`
    UPDATE kbn_cron_runs
    SET status=?,created_count=?,error=?,diagnostic_json=?,finished_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).bind(String(status),Number(createdCount)||0,String(error||"").slice(0,1000),diag,Number(id)).run();
}

async function kbnLastCronRunV224(env,runType=""){
  await ensureKbnCronRunsTableV224(env);
  const where=runType?"WHERE run_type=?":"";
  const q=`
    SELECT id,scheduled_time,scheduled_jst,run_type,status,created_count,error,diagnostic_json,started_at,finished_at
    FROM kbn_cron_runs
    ${where}
    ORDER BY id DESC LIMIT 1
  `;
  return runType
    ? await env.DB.prepare(q).bind(String(runType)).first()
    : await env.DB.prepare(q).first();
}


async function kbnLastAutomaticRunV233(env){
  await ensureKbnCronRunsTableV224(env);
  return await env.DB.prepare(`
    SELECT id,scheduled_time,scheduled_jst,run_type,status,created_count,error,diagnostic_json,started_at,finished_at
    FROM kbn_cron_runs
    WHERE run_type IN ('auto_listing','maintenance')
    ORDER BY id DESC LIMIT 1
  `).first();
}

async function kbnMaintenanceQueueStatusV257(env){
  try{
    await ensureKbnMaintenanceQueueV242(env);
    const q=await env.DB.prepare(`
      SELECT phase,run_date,created_total,updated_at
      FROM kbn_maintenance_queue
      WHERE id=1
    `).first();
    const phase=Number(q?.phase||0);
    const createdTotal=Math.max(0,Number(q?.created_total||0));

    if(!phase){
      return {
        active:false,
        phase:0,
        stage:"idle",
        created_total:createdTotal,
        discovery_batch:0,
        discovery_batches_total:40,
        run_date:q?.run_date||"",
        updated_at:q?.updated_at||""
      };
    }

    if(phase>=11 && phase<=49){
      return {
        active:true,
        phase,
        stage:"discovery",
        created_total:createdTotal,
        // phase 11 is queued batch #2 because batch #1 ran at the scheduled minute.
        discovery_batch:Math.min(40,Math.max(1,phase-9)),
        discovery_batches_total:40,
        run_date:q?.run_date||"",
        updated_at:q?.updated_at||""
      };
    }

    const task=phase===1?"missing":phase===2?"closed":phase===3?"instagram":phase===4?"exclusion":"maintenance";
    return {
      active:true,
      phase,
      stage:"maintenance",
      task,
      created_total:createdTotal,
      discovery_batch:40,
      discovery_batches_total:40,
      run_date:q?.run_date||"",
      updated_at:q?.updated_at||""
    };
  }catch(e){
    return {active:false,stage:"unknown",error:String(e?.message||e)};
  }
}

function kbnDiscoveryDiagnosticV226(result){
  const d=result?.discovery||result||{};
  const searched=Array.isArray(d.searched)?d.searched:[];
  const rejected=Array.isArray(d.rejected)?d.rejected:[];
  const reasonCounts={};
  const sourceFound={google:0,foursquare:0,geoapify:0,osm:0};
  let rawGoogle=0;
  for(const s of searched){
    rawGoogle+=Number(s?.raw_found||0);
    sourceFound.google+=Number(s?.google_found||0);
    sourceFound.foursquare+=Number(s?.fsq_found||0);
    sourceFound.geoapify+=Number(s?.geo_found||0);
    sourceFound.osm+=Number(s?.osm_found||0);
  }
  for(const r of rejected){
    const raw=String(r?.reason||"UNKNOWN").split(",").filter(Boolean);
    if(!raw.length)raw.push("UNKNOWN");
    for(const reason of raw)reasonCounts[reason]=(reasonCounts[reason]||0)+1;
  }
  const topReasons=Object.entries(reasonCounts).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([reason,count])=>({reason,count}));
  const rejectedExamples=[];
  const seenExamples=new Set();
  for(const r of rejected){
    const name=String(r?.name||"").trim();
    const reason=String(r?.reason||"UNKNOWN").trim();
    const key=`${name}|${reason}`;
    if(!name||seenExamples.has(key))continue;
    seenExamples.add(key);
    rejectedExamples.push({name,reason,source:String(r?.source||"")});
    if(rejectedExamples.length>=8)break;
  }
  return {
    searched_pairs:searched.length,
    raw_google_found:rawGoogle,
    source_found:sourceFound,
    candidate_scan_count:searched.reduce((n,s)=>n+Number(s?.candidate_scan_count||0),0),
    detail_checks:searched.reduce((n,s)=>n+Number(s?.detail_checks||0),0),
    rejected_total:rejected.length,
    rejection_reasons:topReasons,
    rejected_examples:rejectedExamples,
    created_count:Array.isArray(d.created)?d.created.length:0,
    passes:Number(d.passes||d.pass_stats?.length||0),
    source_errors:searched.filter(s=>s?.error).slice(0,10).map(s=>({area:s.area,type:s.type,error:s.error}))
  };
}

function kbnEffectiveScheduleV224(env){
  const configured=String(env?.KBN_AUTO_LISTING_TIMES_JST||"")
    .split("|").map(kbnNormalizeJstTime).filter(Boolean);
  const listingTimes=configured.length===6?kbnSortJstTimes(configured):[...KBN_DEFAULT_AUTO_LISTING_TIMES_JST_V217];
  const m=kbnNormalizeJstTime(env?.KBN_FULL_MAINTENANCE_TIME_JST);
  const maintenanceTime=(m&&listingTimes.includes(m))?m:listingTimes[0];
  return {
    auto_listing_times_jst:listingTimes,
    full_maintenance_time_jst:maintenanceTime,
    schedule_updated_at:String(env?.KBN_SCHEDULE_UPDATED_AT||""),
    config_version:String(env?.KBN_CONFIG_VERSION||"")
  };
}


function kbnCronsToJstTimesV225(crons){
  const out=[];
  for(const raw of Array.isArray(crons)?crons:[]){
    const m=String(raw||"").trim().match(/^(\d{1,2})\s+([0-9,]+)\s+\*\s+\*\s+\*$/);
    if(!m)continue;
    const minute=Number(m[1]);
    if(minute<0||minute>59)continue;
    for(const hRaw of m[2].split(",")){
      const hour=Number(hRaw);
      if(hour<0||hour>23)continue;
      const jstMinutes=(hour*60+minute+9*60)%(24*60);
      const jh=Math.floor(jstMinutes/60), jm=jstMinutes%60;
      out.push(`${String(jh).padStart(2,"0")}:${String(jm).padStart(2,"0")}`);
    }
  }
  return kbnSortJstTimes([...new Set(out)]);
}

async function kbnCloudflareSchedulesV225(env){
  const accountId=String(env?.CLOUDFLARE_ACCOUNT_ID||"").trim();
  const apiToken=String(env?.CLOUDFLARE_API_TOKEN||"").trim();
  const workerName=String(env?.CLOUDFLARE_WORKER_NAME||"").trim();
  if(!accountId||!apiToken||!workerName){
    return {configured:false,missing:[!accountId&&"CLOUDFLARE_ACCOUNT_ID",!apiToken&&"CLOUDFLARE_API_TOKEN",!workerName&&"CLOUDFLARE_WORKER_NAME"].filter(Boolean),crons:[],times_jst:[]};
  }
  const r=await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}/schedules`,{
    headers:{"Authorization":`Bearer ${apiToken}`,"Accept":"application/json"}
  });
  const d=await r.json().catch(()=>({}));
  if(!r.ok||!d?.success)throw new Error(d?.errors?.[0]?.message||`CLOUDFLARE_SCHEDULE_GET_HTTP_${r.status}`);
  const schedules=Array.isArray(d?.result?.schedules)?d.result.schedules:[];
  const crons=schedules.map(x=>String(x?.cron||"").trim()).filter(Boolean);
  return {configured:true,crons,times_jst:kbnCronsToJstTimesV225(crons),schedules};
}

async function kbnCloudflareSetSchedulesV225(env,crons){
  const accountId=String(env?.CLOUDFLARE_ACCOUNT_ID||"").trim();
  const apiToken=String(env?.CLOUDFLARE_API_TOKEN||"").trim();
  const workerName=String(env?.CLOUDFLARE_WORKER_NAME||"").trim();
  if(!accountId||!apiToken||!workerName)throw new Error("CLOUDFLARE_SCHEDULE_API_NOT_CONFIGURED");
  const body=(Array.isArray(crons)?crons:[]).map(cron=>({cron:String(cron||"").trim()})).filter(x=>x.cron);
  const r=await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}/schedules`,{
    method:"PUT",
    headers:{"Authorization":`Bearer ${apiToken}`,"Accept":"application/json","Content-Type":"application/json"},
    body:JSON.stringify(body)
  });
  const d=await r.json().catch(()=>({}));
  if(!r.ok||!d?.success)throw new Error(d?.errors?.[0]?.message||`CLOUDFLARE_SCHEDULE_PUT_HTTP_${r.status}`);
  const schedules=Array.isArray(d?.result?.schedules)?d.result.schedules:[];
  const liveCrons=schedules.map(x=>String(x?.cron||"").trim()).filter(Boolean);
  return {ok:true,crons:liveCrons,times_jst:kbnCronsToJstTimesV225(liveCrons),schedules};
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
const KBN_LEAD_TYPES=[["bar", "BAR"], ["darts", "ダーツバー"], ["karaoke", "カラオケバー"], ["snack", "スナック"], ["lounge", "ラウンジ"], ["girls", "ガールズバー"], ["shot", "ショットバー"], ["sports", "スポーツバー"], ["wine", "ワインバー"], ["beer", "ビアバー"], ["cocktail", "カクテルバー"], ["music", "ミュージックバー"], ["shisha", "シーシャバー"], ["concept", "コンセプトバー"], ["cafebar", "カフェバー"], ["pub", "パブ"], ["night", "ナイトバー"], ["standing", "立ち飲みバー"], ["craft", "クラフトビール"], ["whisky", "ウイスキーバー"]];

// v2.53: 同じ「市×ジャンル」検索の繰り返しを減らし、未開拓の繁華街・地区を優先する。
// area は店舗判定用の正式エリア、search_area はGoogle検索専用の細かい検索地点。
const KBN_DISCOVERY_SPOTS=[
  {area:"熊本市",search_area:"熊本市 下通"},
  {area:"熊本市",search_area:"熊本市 上通"},
  {area:"熊本市",search_area:"熊本市 新市街"},
  {area:"熊本市",search_area:"熊本市 中央街"},
  {area:"熊本市",search_area:"熊本市 花畑町"},
  {area:"熊本市",search_area:"熊本市 安政町"},
  {area:"熊本市",search_area:"熊本市 手取本町"},
  {area:"熊本市",search_area:"熊本市 南坪井町"},
  {area:"熊本市",search_area:"熊本市 並木坂"},
  {area:"熊本市",search_area:"熊本市 辛島町"},
  {area:"熊本市",search_area:"熊本市 銀座通り"},
  {area:"熊本市",search_area:"熊本市 駕町通り"},
  {area:"熊本市",search_area:"熊本市 シャワー通り"},
  {area:"熊本市",search_area:"熊本市 上乃裏"},
  {area:"熊本市",search_area:"熊本市 熊本駅"},
  {area:"熊本市",search_area:"熊本市 水前寺"},
  {area:"熊本市",search_area:"熊本市 健軍"},
  {area:"熊本市",search_area:"熊本市 武蔵ヶ丘"},
  {area:"熊本市",search_area:"熊本市 楠"},
  {area:"熊本市",search_area:"熊本市 植木"},
  {area:"八代市",search_area:"八代市 本町"},
  {area:"八代市",search_area:"八代市 袋町"},
  {area:"八代市",search_area:"八代市 旭中央通"},
  {area:"人吉市",search_area:"人吉市 紺屋町"},
  {area:"人吉市",search_area:"人吉市 九日町"},
  {area:"玉名市",search_area:"玉名市 高瀬"},
  {area:"玉名市",search_area:"玉名市 繁根木"},
  {area:"荒尾市",search_area:"荒尾市"},
  {area:"荒尾市",search_area:"荒尾市 万田"},
  {area:"山鹿市",search_area:"山鹿市"},
  {area:"山鹿市",search_area:"山鹿市 温泉街"},
  {area:"菊池市",search_area:"菊池市"},
  {area:"菊池市",search_area:"菊池市 隈府"},
  {area:"合志市",search_area:"合志市"},
  {area:"菊陽町",search_area:"菊陽町 光の森"},
  {area:"菊陽町",search_area:"菊陽町 津久礼"},
  {area:"大津町",search_area:"大津町"},
  {area:"大津町",search_area:"大津町 室"},
  {area:"宇城市",search_area:"宇城市 松橋"},
  {area:"宇城市",search_area:"宇城市 小川"},
  {area:"宇土市",search_area:"宇土市"},
  {area:"天草市",search_area:"天草市 本渡"},
  {area:"天草市",search_area:"天草市 中央新町"},
  {area:"上天草市",search_area:"上天草市"},
  {area:"阿蘇市",search_area:"阿蘇市"},
  {area:"阿蘇市",search_area:"阿蘇市 内牧"},
  {area:"水俣市",search_area:"水俣市"},
  {area:"益城町",search_area:"益城町"},
  {area:"御船町",search_area:"御船町"},
  {area:"嘉島町",search_area:"嘉島町"},
  {area:"長洲町",search_area:"長洲町"},
  {area:"南関町",search_area:"南関町"},
  {area:"芦北町",search_area:"芦北町"},
  {area:"あさぎり町",search_area:"あさぎり町"}
]


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
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS auto_listing_deleted_history(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_shop_id INTEGER,
      slug TEXT,
      name TEXT NOT NULL,
      area TEXT,
      address TEXT,
      phone TEXT,
      instagram TEXT,
      genre TEXT,
      snapshot_json TEXT,
      deleted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(original_shop_id)
    )
  `).run();
  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_auto_deleted_name
    ON auto_listing_deleted_history(name)
  `).run();
}

async function archiveDeletedAutoListing(env,shop){
  if(!shop||!shop.id)return;
  await ensureLeadDiscoveryTables(env);
  await env.DB.prepare(`
    INSERT INTO auto_listing_deleted_history(
      original_shop_id,slug,name,area,address,phone,instagram,genre,snapshot_json,deleted_at
    ) VALUES(?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(original_shop_id) DO UPDATE SET
      slug=excluded.slug,
      name=excluded.name,
      area=excluded.area,
      address=excluded.address,
      phone=excluded.phone,
      instagram=excluded.instagram,
      genre=excluded.genre,
      snapshot_json=excluded.snapshot_json,
      deleted_at=CURRENT_TIMESTAMP
  `).bind(
    Number(shop.id),
    t(shop.slug||"",220),
    t(shop.name||"",150),
    t(shop.area||"",120),
    t(shop.address||"",500),
    t(shop.phone||"",80),
    t(shop.instagram||"",220),
    t(shop.genre||"",120),
    JSON.stringify(shop)
  ).run();
}

async function loadDeletedAutoListings(env){
  await ensureLeadDiscoveryTables(env);
  const r=await env.DB.prepare(`
    SELECT original_shop_id AS id,slug,name,area,address,phone,instagram,genre
    FROM auto_listing_deleted_history
  `).all();
  return r.results||[];
}

function kbnHandle(v){
  return String(v||"").replace(/^https?:\/\/(www\.)?instagram\.com\//i,"")
    .replace(/^@/,"").split(/[\/?#]/)[0].trim().toLowerCase();
}

async function autoDiscoveryPairs(env,limit=4,uniqueAreas=false){
  await ensureLeadDiscoveryTables(env);
  const r=await env.DB.prepare(`
    SELECT area,lead_type,MAX(searched_at) last_searched
    FROM lead_discovery_runs GROUP BY area,lead_type
  `).all();
  const m=new Map((r.results||[]).map(x=>[`${x.area}||${x.lead_type}`,x.last_searched||""]));

  let areaCountRows=[];
  try{
    const c=await env.DB.prepare(`SELECT area,COUNT(*) shop_count FROM shops WHERE is_published=1 GROUP BY area`).all();
    areaCountRows=c.results||[];
  }catch{}
  const areaCounts=new Map(areaCountRows.map(x=>[String(x.area||""),Number(x.shop_count||0)]));

  const spots=Array.isArray(KBN_DISCOVERY_SPOTS)&&KBN_DISCOVERY_SPOTS.length
    ? KBN_DISCOVERY_SPOTS
    : KBN_AREAS.map(area=>({area,search_area:area}));

  const p=[];
  for(const spot of spots){
    for(const [type,label] of KBN_LEAD_TYPES){
      const area=String(spot.area||"").trim();
      const searchArea=String(spot.search_area||area).trim();
      const runKey=`${searchArea}||${type}`;
      p.push({
        area,
        search_area:searchArea,
        type,
        label,
        last:m.get(runKey)||"",
        shop_count:areaCounts.get(area)||0
      });
    }
  }

  p.sort((a,b)=>{
    // 未検索の「地区×ジャンル」を最優先。
    if(!a.last&&b.last)return -1;
    if(a.last&&!b.last)return 1;
    // 同条件なら掲載数の少ない市町村を優先。
    if(a.shop_count!==b.shop_count)return a.shop_count-b.shop_count;
    // 最後に、長く検索していない地区から。
    return String(a.last).localeCompare(String(b.last));
  });

  const safeLimit=Math.max(1,Math.min(Number(limit)||4,40));

  // v2.91: 自動掲載で地区数を指定した場合は、候補リストを先に切らず、
  // ソート済み全候補から「実際に異なる地区」を必要数だけ選ぶ。
  // これにより同一地区のBAR/スナック/ラウンジ等が上位を占めても、
  // 3地区程度で止まらず、候補が存在する限り最大7地区まで必ず進む。
  if(uniqueAreas){
    const selected=[];
    const seenAreas=new Set();
    for(const pair of p){
      const key=String(pair?.search_area||pair?.area||"").trim();
      if(!key||seenAreas.has(key))continue;
      seenAreas.add(key);
      selected.push(pair);
      if(selected.length>=safeLimit)break;
    }
    return selected;
  }

  return p.slice(0,safeLimit);
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
          "User-Agent":"KUMAMOTO-BAR-NAVI/1.76"
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
  const empty={ok:false,price:{min:null,max:null},hours:"",holiday:"",features:"",instagram:""};
  if(!target || /instagram\.com|facebook\.com|x\.com|twitter\.com/i.test(target)){
    return empty;
  }
  try{
    const r=await fetch(target,{
      headers:{"User-Agent":"Mozilla/5.0 KUMAMOTO-BAR-NAVI/1.76"}
    });
    if(!r.ok)return empty;
    const ct=String(r.headers.get("content-type")||"");
    if(!/text\/html|text\/plain/i.test(ct))return empty;
    let html=await r.text();
    if(html.length>250000)html=html.slice(0,250000);

    let instagram="";
    const links=[...html.matchAll(/https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9._]+)/gi)];
    for(const m of links){
      const h=String(m?.[1]||"").trim();
      if(!h)continue;
      if(["p","reel","reels","stories","explore","accounts","direct"].includes(h.toLowerCase()))continue;
      instagram=`https://www.instagram.com/${h}/`;
      break;
    }

    const text=htmlToText(html);
    return {
      ok:true,
      price:extractPriceInfo(text),
      hours:extractHoursInfo(text),
      holiday:extractHolidayInfo(text),
      features:extractFeaturesInfo(text),
      instagram
    };
  }catch{
    return empty;
  }
}

function instagramSearchScore({shopName="",area="",handle="",title="",snippet=""}={}){
  const text=`${title||""} ${snippet||""}`;
  const handleText=String(handle||"").replace(/[._]/g," ");
  const nameScore=Math.max(
    placeNameMatchScore(shopName,title||""),
    placeNameMatchScore(shopName,snippet||""),
    placeNameMatchScore(shopName,handleText)
  );

  let score=Math.round(nameScore*0.72);
  const normName=normalizePlaceName(shopName);
  const normText=normalizePlaceName(text);
  if(normName && normText && normText.includes(normName))score+=22;
  if(area && text.includes(area))score+=10;
  if(/熊本/.test(text))score+=6;
  if(/bar|バー|シーシャ|ラウンジ|スナック|ダーツ|カラオケ|ナイト|club|クラブ/i.test(text))score+=5;
  if(/公式|official/i.test(text))score+=8;

  return Math.max(0,Math.min(99,score));
}

async function discoverInstagramForShop(env,{name,area,website="",existing=""}={}){
  const current=kbnHandle(existing);
  if(current){
    return {
      ok:true,instagram:`https://www.instagram.com/${current}/`,
      score:100,confidence:"high",source:"existing"
    };
  }

  // 公式サイトから直接リンクされているInstagramは最優先
  if(website){
    const meta=await fetchOfficialWebsiteMetadata(website);
    const h=kbnHandle(meta?.instagram||"");
    if(h){
      return {
        ok:true,instagram:`https://www.instagram.com/${h}/`,
        score:100,confidence:"official",source:"official_website"
      };
    }
  }

  // Google検索(SerpApi)で候補を探して一致度を採点
  const cfg=leadSearchConfig(env);
  if(!cfg.apiKey){
    return {ok:false,configured:false,error:"SERPAPI_NOT_CONFIGURED",instagram:"",score:0,candidates:[]};
  }

  const query=`"${String(name||"").trim()}" Instagram ${String(area||"熊本").trim()} 熊本`;
  const sr=await serpApiGoogleSearch(env,{q:query,start:0,num:10});
  if(!sr.ok){
    return {ok:false,configured:true,error:sr.error||"INSTAGRAM_SEARCH_FAILED",instagram:"",score:0,candidates:[]};
  }

  const seen=new Set();
  const candidates=[];
  for(const item of (sr.results||[])){
    const handle=extractInstagramHandleFromUrl(item?.link||"");
    if(!handle)continue;
    const key=handle.toLowerCase();
    if(seen.has(key))continue;
    seen.add(key);

    const score=instagramSearchScore({
      shopName:name,
      area,
      handle,
      title:String(item?.title||""),
      snippet:String(item?.snippet||"")
    });

    candidates.push({
      handle,
      instagram:`https://www.instagram.com/${handle}/`,
      score,
      title:t(item?.title,300),
      snippet:t(item?.snippet,700)
    });
  }

  candidates.sort((a,b)=>b.score-a.score);
  const best=candidates[0]||null;

  if(best && best.score>=90){
    return {
      ok:true,configured:true,instagram:best.instagram,
      score:best.score,confidence:"high",source:"google_instagram_search",
      candidates:candidates.slice(0,5)
    };
  }

  return {
    ok:true,configured:true,instagram:"",
    score:Number(best?.score||0),
    confidence:best&&best.score>=70?"candidate":"low",
    source:"google_instagram_search",
    candidates:candidates.slice(0,5)
  };
}


async function findOpenDataPlaceForShop(env,{name,area}){
  // 1) Google Places first: use as the strongest existence/name/area verifier.
  const google=await findGooglePlaceForShop(env,{name,area});

  // 2) Secondary sources independently provide the persisted business fields.
  const fsq=await findFoursquarePlaceForShop(env,{name,area});
  const geo=await findGeoapifyPlaceForShop(env,{name,area});
  const osmSnap=await fetchKumamotoOsmBars(env);

  let osmMatch=null;
  if(osmSnap.ok){
    const ranked=osmSnap.places
      .map(place=>({place,score:osmPlaceScore(place,{name,area})}))
      .sort((a,b)=>b.score-a.score);
    if(ranked[0]&&ranked[0].score>=78)osmMatch=ranked[0];
  }

  // Google matched: require/use the best confirming secondary source when available.
  if(google.ok&&google.matched){
    const gName=googlePlaceName(google.place);
    const gAddress=googlePlaceAddress(google.place);
    const secondary=[];

    if(fsq.ok&&fsq.matched){
      secondary.push({
        kind:"foursquare",
        fsq_place:fsq.place,
        score:crossSourceNameAreaScore(gName,gAddress,fsqName(fsq.place),fsqAddress(fsq.place))
      });
    }
    if(geo.ok&&geo.matched){
      secondary.push({
        kind:"geoapify",
        feature:geo.feature,
        score:crossSourceNameAreaScore(gName,gAddress,geoName(geo.feature),geoAddress(geo.feature))
      });
    }
    if(osmMatch){
      secondary.push({
        kind:"osm",
        place:osmMatch.place,
        score:crossSourceNameAreaScore(gName,gAddress,osmPlaceName(osmMatch.place),osmAddress(osmMatch.place))
      });
    }

    secondary.sort((a,b)=>b.score-a.score);
    const best=secondary.find(x=>x.score>=82);

    if(best){
      return {
        ok:true,
        matched:true,
        kind:best.kind,
        place:best.place,
        feature:best.feature,
        fsq_place:best.fsq_place,
        score:Math.max(Number(google.score||0),Number(best.score||0)),
        confidence:"high",
        source:`google_places+${best.kind}`,
        google_place_id:String(google.place?.id||"")
      };
    }
  }

  // If Google is unavailable / no confident match, continue with the existing fallback chain.
  if(fsq.ok&&fsq.matched){
    return {
      ok:true,matched:true,kind:"foursquare",fsq_place:fsq.place,score:fsq.score,
      confidence:fsq.confidence,source:"foursquare"
    };
  }

  if(geo.ok&&geo.matched){
    return {
      ok:true,matched:true,kind:"geoapify",feature:geo.feature,score:geo.score,
      confidence:geo.confidence,source:"geoapify"
    };
  }

  if(osmMatch){
    return {
      ok:true,matched:true,kind:"osm",place:osmMatch.place,score:osmMatch.score,
      confidence:osmMatch.score>=100?"high":"medium",
      source:osmSnap.source
    };
  }

  if(!google.configured&&!fsq.configured&&!geo.configured&&!osmSnap.ok){
    return {
      ok:false,
      error:google.error||fsq.error||geo.error||osmSnap.error||"DISCOVERY_SOURCES_UNAVAILABLE",
      matched:false
    };
  }

  return {
    ok:true,
    matched:false,
    score:Math.max(
      Number(google.score||0),
      Number(fsq.score||0),
      Number(geo.score||0),
      Number(osmMatch?.score||0)
    ),
    source:google.configured?"google_places":(fsq.configured?"foursquare":(geo.configured?"geoapify":"osm"))
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

async function refreshIndependentListings(env,{limit=10,afterId=0,revalidate=false,force=false,missingOnly=false}={}){
  const max=Math.max(1,Math.min(Number(limit)||10,30));
  const cursor=Math.max(0,Number(afterId)||0);

  const r=await env.DB.prepare(`
    SELECT id,name,area,address,hours,holiday,instagram,genre,features,description,
           budget_min,budget_max,seats,phone,listing_status,is_published
    FROM shops
    WHERE COALESCE(listing_status,'published')='provisional'
      AND id>?
      AND (
        ?=0 OR
        COALESCE(TRIM(hours),'')='' OR
        COALESCE(TRIM(phone),'')='' OR
        budget_min IS NULL OR budget_max IS NULL OR
        COALESCE(TRIM(address),'')='' OR
        COALESCE(TRIM(features),'')='' OR
        COALESCE(TRIM(instagram),'')=''
      )
    ORDER BY id ASC
    LIMIT ?
  `).bind(cursor,missingOnly?1:0,max).all();

  const rows=r.results||[];
  const updated=[],unchanged=[],failed=[];

  for(const shop of rows){
    try{
      const cleanName=String(shop.name||"").replace(/^【KBN独自掲載】/,"").trim();

      // 1) Googleで存在・店名・エリアを照合
      const found=await findGooglePlaceForShop(env,{name:cleanName,area:shop.area||"熊本"});
      if(!found.ok){
        failed.push({id:shop.id,name:shop.name,reason:found.error||"GOOGLE_PLACES_ERROR"});
        continue;
      }
      if(!found.matched){
        unchanged.push({id:shop.id,name:shop.name,reason:"GOOGLE_MATCH_NOT_FOUND"});
        continue;
      }

      // 2) Place IDから詳細情報を取得
      const details=await googlePlaceDetails(env,found.place?.id);
      const gp=details.ok&&details.place?details.place:found.place;

      const gName=t(googlePlaceName(gp)||cleanName,150);
      const gAddress=t(googlePlaceAddress(gp)||shop.address||"",500);
      const gPhone=t(googlePhone(gp)||"",80);
      const gHours=t(googleOpeningHours(gp)||"",800);
      const gHoliday=t(googleHolidayFromHours(gp)||"",180);
      const gWebsite=googleWebsite(gp);
      const gFeatures=googleDetailFeatures(gp);
      const gPrice=googlePriceInfo(gp);
      const area=inferKumamotoAreaFromText(gAddress,shop.area||"熊本市");

      // 3) 補助APIでGoogleにない項目を補完
      const fsq=await findFoursquarePlaceForShop(env,{name:gName,area});
      const geo=await findGeoapifyPlaceForShop(env,{name:gName,area});
      const osmSnap=await fetchKumamotoOsmBars(env);

      let osmMatch=null;
      if(osmSnap.ok){
        const ranked=osmSnap.places
          .map(place=>({place,score:osmPlaceScore(place,{name:gName,area})}))
          .sort((a,b)=>b.score-a.score);
        if(ranked[0]&&ranked[0].score>=78)osmMatch=ranked[0].place;
      }

      const fsqPlace=fsq.ok&&fsq.matched?fsq.place:null;
      const geoFeature=geo.ok&&geo.matched?geo.feature:null;

      const phone=gPhone ||
        (fsqPlace?fsqPhone(fsqPlace):"") ||
        (geoFeature?geoPhone(geoFeature):"") ||
        (osmMatch?osmPhone(osmMatch):"") ||
        shop.phone || "";

      const hours=gHours ||
        (fsqPlace?fsqHours(fsqPlace):"") ||
        (geoFeature?geoHours(geoFeature):"") ||
        (osmMatch?osmHours(osmMatch):"") ||
        shop.hours || "";

      const holiday=gHoliday ||
        (osmMatch?osmHoliday(osmMatch):"") ||
        shop.holiday || "";

      const website=gWebsite ||
        (fsqPlace?fsqWebsite(fsqPlace):"") ||
        (geoFeature?geoWebsite(geoFeature):"") ||
        (osmMatch?osmWebsite(osmMatch):"");

      let instagram=
        (fsqPlace?fsqInstagram(fsqPlace):"") ||
        (geoFeature?geoInstagram(geoFeature):"") ||
        (osmMatch?osmInstagram(osmMatch):"") ||
        shop.instagram || "";

      let features=[
        gFeatures,
        fsqPlace?extractFeaturesInfo(`${fsqCategories(fsqPlace).join(" ")} ${gName}`):"",
        geoFeature?extractFeaturesInfo(`${geoCategories(geoFeature).join(" ")} ${gName}`):"",
        osmMatch?osmFeatures(osmMatch):"",
        shop.features||""
      ].filter(Boolean).join("、");

      // 4) 公式Webがある場合はさらに補完
      const webMeta=website?await fetchOfficialWebsiteMetadata(website):
        {ok:false,price:{min:null,max:null},hours:"",holiday:"",features:"",instagram:""};

      if(!instagram && webMeta.instagram)instagram=webMeta.instagram;

      let instagramDiscovery=null;
      if(!instagram){
        instagramDiscovery=await discoverInstagramForShop(env,{
          name:gName,area,website,existing:shop.instagram||""
        });
        if(instagramDiscovery?.instagram && Number(instagramDiscovery.score||0)>=90){
          instagram=instagramDiscovery.instagram;
        }else if(instagramDiscovery?.confidence==="candidate" && instagramDiscovery?.candidates?.[0]){
          const top=instagramDiscovery.candidates[0];
          await createKbnAlert(env,{
            type:"instagram_candidate",
            title:`Instagram候補: ${gName}`,
            message:`@${top.handle} / 一致度 ${top.score}% — 自動保存せず候補として保留しました。`,
            shopId:shop.id
          });
        }
      }

      const finalHours=hours||webMeta.hours||shop.hours||"";
      const finalHoliday=holiday||webMeta.holiday||shop.holiday||"";
      if(webMeta.features)features=[features,webMeta.features].filter(Boolean).join("、");

      const budgetMin=
        webMeta.price?.min ??
        gPrice.min ??
        shop.budget_min ??
        null;

      const budgetMax=
        webMeta.price?.max ??
        gPrice.max ??
        shop.budget_max ??
        null;

      const changed=
        String(area)!==String(shop.area||"") ||
        String(gAddress)!==String(shop.address||"") ||
        String(phone)!==String(shop.phone||"") ||
        String(finalHours)!==String(shop.hours||"") ||
        String(finalHoliday)!==String(shop.holiday||"") ||
        String(instagram)!==String(shop.instagram||"") ||
        String(features)!==String(shop.features||"") ||
        Number(budgetMin??-1)!==Number(shop.budget_min??-1) ||
        Number(budgetMax??-1)!==Number(shop.budget_max??-1);

      if(!changed){
        unchanged.push({
          id:shop.id,name:shop.name,reason:"NO_CHANGE",
          match_score:found.score,
          details_ok:!!details.ok
        });
        continue;
      }

      await env.DB.prepare(`
        UPDATE shops SET
          area=?,address=?,hours=?,holiday=?,instagram=?,features=?,
          budget_min=?,budget_max=?,phone=?,updated_at=CURRENT_TIMESTAMP
        WHERE id=?
      `).bind(
        area,gAddress,finalHours,finalHoliday,instagram,features,
        budgetMin,budgetMax,phone,shop.id
      ).run();

      updated.push({
        id:shop.id,name:shop.name,area,address:gAddress,phone,
        hours:finalHours,holiday:finalHoliday,instagram,
        budget_min:budgetMin,budget_max:budgetMax,
        match_confidence:found.confidence,match_score:found.score,
        google_details:!!details.ok,
        source:"google_details+secondary+official_web"
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
      AND (
        ?=0 OR
        COALESCE(TRIM(hours),'')='' OR
        COALESCE(TRIM(phone),'')='' OR
        budget_min IS NULL OR budget_max IS NULL OR
        COALESCE(TRIM(address),'')='' OR
        COALESCE(TRIM(features),'')='' OR
        COALESCE(TRIM(instagram),'')=''
      )
    ORDER BY id ASC LIMIT 1
  `).bind(nextAfterId,missingOnly?1:0).first();

  return {
    ok:true,checked:rows.length,updated,unchanged,failed,
    next_after_id:nextAfterId,has_more:!!moreR,
    provider:"google_details_secondary_official_web"
  };
}
async function refreshMissingShopImages(env,{limit=20,afterId=0}={}){
  const max=Math.max(1,Math.min(Number(limit)||20,30));
  const cursor=Math.max(0,Number(afterId)||0);
  const r=await env.DB.prepare(`
    SELECT id,name,area,address,image_url,image_key
    FROM shops
    WHERE id>?
      AND COALESCE(is_published,1)=1
      AND COALESCE(TRIM(image_url),'')=''
    ORDER BY id ASC LIMIT ?
  `).bind(cursor,max).all();
  const rows=r.results||[],updated=[],unchanged=[],failed=[];
  for(const shop of rows){
    try{
      const cleanName=String(shop.name||"").replace(/^【KBN独自掲載】/,"").trim();
      const found=await findGooglePlaceForShop(env,{name:cleanName,area:shop.area||"熊本"});
      if(!found.ok||!found.matched){
        unchanged.push({id:shop.id,name:shop.name,reason:found.error||"GOOGLE_MATCH_NOT_FOUND"});
        continue;
      }
      const details=await googlePlaceDetails(env,found.place?.id);
      const gp=details.ok&&details.place?details.place:found.place;
      const photoName=googlePhotoName(gp);
      if(!photoName){
        unchanged.push({id:shop.id,name:shop.name,reason:"GOOGLE_PHOTO_NOT_FOUND"});
        continue;
      }
      const imageUrl=googlePhotoProxyUrl(shop.id);
      await env.DB.prepare(`UPDATE shops SET image_url=?,image_key=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .bind(imageUrl,`google:${photoName}`,shop.id).run();
      updated.push({id:shop.id,name:shop.name,image_url:imageUrl,source:"google_places_photo"});
    }catch(e){
      failed.push({id:shop.id,name:shop.name,reason:String(e?.message||e||"IMAGE_REFRESH_ERROR").slice(0,250)});
    }
  }
  const next=rows.length?Number(rows[rows.length-1].id||0):cursor;
  const more=await env.DB.prepare(`SELECT id FROM shops WHERE id>? AND COALESCE(is_published,1)=1 AND COALESCE(TRIM(image_url),'')='' ORDER BY id ASC LIMIT 1`).bind(next).first();
  return {ok:true,checked:rows.length,updated,unchanged,failed,next_after_id:next,has_more:!!more};
}

function googlePlacesConfig(env){
  return {apiKey:t(env.GOOGLE_PLACES_API_KEY,2000)};
}

function googlePlaceName(place){
  return String(place?.displayName?.text||"").trim();
}

function googlePlaceAddress(place){
  return String(place?.formattedAddress||"").replace(/\s+/g," ").trim();
}

function googlePlaceTypes(place){
  return [
    String(place?.primaryType||""),
    ...(Array.isArray(place?.types)?place.types.map(String):[])
  ].filter(Boolean);
}


// v2.58: 自動掲載は「明確に夜業態 / BAR系」と確認できる店だけ通す。
function kbnExplicitBarSignal(text=""){
  const s=String(text||"").toLowerCase();
  return [
    "bar","バー","pub","パブ","snack","スナック","lounge","ラウンジ",
    "darts bar","ダーツバー","karaoke bar","カラオケバー",
    "shisha bar","シーシャバー","cocktail bar","カクテルバー",
    "wine bar","ワインバー","beer bar","ビアバー",
    "shot bar","ショットバー","music bar","ミュージックバー",
    "sports bar","スポーツバー","girls bar","ガールズバー",
    "コンカフェ","night club","nightclub","ナイトクラブ"
  ].some(x=>s.includes(x));
}

function kbnHardNonBarSignal(text=""){
  const s=String(text||"").toLowerCase();
  return [
    "居酒屋","izakaya","焼鳥","焼き鳥","やきとり","串焼","串カツ",
    "ラーメン","うどん","そば","寿司","鮨","焼肉","食堂","定食",
    "レストラン","restaurant","カフェ","cafe","喫茶",
    "カラオケ店","カラオケボックス","カラオケスタジオ","karaoke box",
    "温泉","銭湯","浴場","spa","スパ","サウナ","sauna",
    "ホテル","旅館","宿泊","hotel","lodging",
    "スポーツクラブ","フィットネスクラブ","テニスクラブ","ゴルフクラブ",
    "ジム","gym","fitness","ボウリング",
    "美容","ネイル","エステ","病院","歯科","整体","マッサージ",
    "コンビニ","スーパー","不動産","建設","学校","塾"
  ].some(x=>s.includes(x));
}

function kbnStrongNightType(types=""){
  const s=String(types||"").toLowerCase();
  return [
    "bar","pub","night_club","night club","cocktail_bar","wine_bar"
  ].some(x=>s.includes(x));
}


async function ensureKbnExclusionCandidateIgnoresV265(env){
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS kbn_exclusion_candidate_ignores(
      shop_id INTEGER PRIMARY KEY,
      note TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
}

async function kbnIgnoredExclusionShopIdsV265(env){
  await ensureKbnExclusionCandidateIgnoresV265(env);
  const r=await env.DB.prepare(`
    SELECT shop_id FROM kbn_exclusion_candidate_ignores
  `).all();
  return new Set((r.results||[]).map(x=>Number(x.shop_id)).filter(Boolean));
}

function kbnExclusionCandidateV259(shop){
  const name=String(shop?.name||"").trim();
  const genre=String(shop?.genre||"").trim();
  const features=String(shop?.features||"").trim();
  const description=String(shop?.description||"").trim();
  const address=String(shop?.address||"").trim();

  const nameLow=name.toLowerCase();
  const metaText=[genre,features,description,address].filter(Boolean).join(" ").toLowerCase();

  const reasons=[];
  let score=0;

  const add=(label,points)=>{
    if(!reasons.includes(label))reasons.push(label);
    score=Math.max(score,points);
  };

  // -------------------------
  // 1) 店名を最優先で判定
  // -------------------------
  // 「カラオケバー」「BAR○○」のように、店名そのものがBARを明示している場合は保護。
  const explicitBarInName=kbnExplicitBarSignal(name);

  // 通常カラオケ店・大手カラオケチェーン
  const karaokeChain=
    /カラオケ館|ビッグエコー|big\s*echo|ジャンカラ|まねきねこ|コロッケ倶楽部|カラオケバンバン|banban|カラオケ本舗|カラオケクラブ|カラオケスタジオ/i.test(name);

  const normalKaraokeName=
    /カラオケ|karaoke/i.test(name) &&
    !/(?:カラオケ\s*bar|カラオケバー|karaoke\s*bar)/i.test(name);

  if(karaokeChain || normalKaraokeName){
    add("通常カラオケ店の可能性",100);
  }

  // 居酒屋・一般飲食
  if(/居酒屋|izakaya|焼鳥|焼き鳥|やきとり|串焼|串カツ|食堂|定食|ラーメン|うどん|そば|寿司|鮨/i.test(name)){
    add("居酒屋・一般飲食店系",100);
  }

  // 温泉・サウナ・スパ
  if(/温泉|銭湯|浴場|spa|スパ|サウナ|sauna/i.test(name)){
    add("温泉・スパ・サウナ系",100);
  }

  // スポーツ・フィットネス
  if(/スポーツクラブ|フィットネスクラブ|テニスクラブ|ゴルフクラブ|ジム|gym|fitness|ボウリング/i.test(name)){
    add("スポーツ・フィットネス系",100);
  }

  // 宿泊施設
  if(/ホテル|旅館|宿泊|hotel|lodging/i.test(name)){
    add("宿泊施設系",95);
  }

  // カフェ・レストラン
  if(/レストラン|restaurant|カフェ|cafe|喫茶/i.test(name) && !explicitBarInName){
    add("一般飲食・カフェ系",85);
  }

  // 美容・医療など
  if(/美容|ネイル|エステ|病院|歯科|整体|マッサージ|コンビニ|スーパー|不動産|建設|学校|塾/i.test(name)){
    add("その他非BAR業態",100);
  }

  // -------------------------
  // 2) メタ情報は補助判定
  // -------------------------
  // 自動掲載時に genre が誤って「カラオケBAR」「ナイトクラブ」になっているケースがあるため、
  // genreだけをBAR根拠にはしない。
  if(!score){
    if(/温泉|銭湯|サウナ|spa|スポーツクラブ|テニスクラブ|フィットネス|ホテル|旅館/.test(metaText)){
      add("掲載情報から非BAR業態の可能性",80);
    }else if(/居酒屋|レストラン|食堂|カラオケボックス|カラオケスタジオ/.test(metaText) && !explicitBarInName){
      add("掲載情報から非BAR業態の可能性",78);
    }
  }

  // 店名そのものにBAR/バー/Pub/スナック/ラウンジ等が明確なら、
  // 一般語の誤検知は候補から外す。ただし通常カラオケチェーン等の強い判定は優先。
  const strongNonBar=score>=95;
  if(explicitBarInName && !strongNonBar){
    return {candidate:false,score:0,reasons:[]};
  }

  return {
    candidate:score>=75,
    score,
    reasons:[...new Set(reasons)]
  };
}

async function kbnScanExclusionCandidatesV267(env){
  const ignoredIds=await kbnIgnoredExclusionShopIdsV265(env);

  const r=await env.DB.prepare(`
    SELECT id,slug,name,area,genre,address,features,description,instagram,
           is_published,listing_status,created_at,updated_at
    FROM shops
    WHERE is_published=1
    ORDER BY id DESC
  `).all();

  const candidates=[];
  for(const shop of (r.results||[])){
    if(ignoredIds.has(Number(shop.id)))continue;

    const check=kbnExclusionCandidateV259(shop);
    if(!check.candidate)continue;

    candidates.push({
      id:Number(shop.id),
      slug:shop.slug||"",
      name:shop.name||"",
      area:shop.area||"",
      genre:shop.genre||"",
      listing_status:normalizeListingStatus(shop.listing_status),
      score:Number(check.score||0),
      reasons:check.reasons||[]
    });
  }

  candidates.sort((a,b)=>
    b.score-a.score ||
    (a.listing_status==="provisional"?-1:1) ||
    b.id-a.id
  );

  return {
    ok:true,
    checked:Number((r.results||[]).length),
    ignored_count:ignoredIds.size,
    candidate_count:candidates.length,
    candidates
  };
}

async function kbnDeleteShopCompletelyV259(env,id,{archive=true}={}){
  const shop=await env.DB.prepare("SELECT * FROM shops WHERE id=? LIMIT 1").bind(id).first();
  if(!shop)return {ok:false,id,error:"NOT_FOUND"};

  if(archive){
    try{await archiveDeletedAutoListing(env,shop)}catch(e){console.error("archive excluded shop failed",id,e)}
  }

  const tableExists=async(name)=>{
    const row=await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
    ).bind(name).first();
    return !!row;
  };

  const related=[
    ["shop_images","DELETE FROM shop_images WHERE shop_id=?"],
    ["shop_analytics","DELETE FROM shop_analytics WHERE shop_id=?"],
    ["jobs","DELETE FROM jobs WHERE shop_id=?"],
    ["owner_requests","DELETE FROM owner_requests WHERE shop_id=?"],
    ["member_favorites","DELETE FROM member_favorites WHERE shop_id=?"],
    ["shop_views","DELETE FROM shop_views WHERE shop_id=?"]
  ];

  for(const [table,sql] of related){
    try{
      if(await tableExists(table))await env.DB.prepare(sql).bind(id).run();
    }catch(e){
      console.error("related delete failed",table,id,e);
    }
  }

  await env.DB.prepare("DELETE FROM shops WHERE id=?").bind(id).run();
  return {ok:true,id:Number(id),name:shop.name||""};
}

function googlePlaceLooksLikeBar(place){
  const types=googlePlaceTypes(place).join(" ").toLowerCase();
  const name=googlePlaceName(place);
  const text=`${name} ${types}`;

  const explicit=kbnExplicitBarSignal(text);
  const strongType=kbnStrongNightType(types);
  const hardNonBar=kbnHardNonBarSignal(text);

  // 明確な非BAR業態は、店名にBAR系ワードがあっても原則除外。
  // 例外は「焼肉BAR」「Cafe Bar」のようにBARが店名として明示され、
  // Google側もbar/pub/night_club等の夜業態typeを返している場合だけ。
  if(hardNonBar && !(explicit && strongType))return false;

  // 自動掲載はホワイトリスト方式。
  // 店名かGoogle typeのどちらかでBAR/夜業態を明確に確認できない候補は通さない。
  if(!explicit && !strongType)return false;

  return true;
}
function googlePlaceScore(place,{name="",area=""}={}){
  let score=placeNameMatchScore(name,googlePlaceName(place));
  const address=googlePlaceAddress(place);
  if(area&&address.includes(area))score+=18;
  else if(address.includes("熊本"))score+=8;
  if(googlePlaceLooksLikeBar(place))score+=12;
  return score;
}

async function googlePlacesTextSearch(env,{query,pageSize=20}){
  const cfg=googlePlacesConfig(env);
  if(!cfg.apiKey){
    return {ok:false,configured:false,error:"GOOGLE_PLACES_NOT_CONFIGURED",places:[]};
  }

  try{
    const r=await fetch("https://places.googleapis.com/v1/places:searchText",{
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        "X-Goog-Api-Key":cfg.apiKey,
        "X-Goog-FieldMask":"places.id,places.displayName,places.formattedAddress,places.primaryType,places.types"
      },
      body:JSON.stringify({
        textQuery:String(query||""),
        languageCode:"ja",
        regionCode:"JP",
        pageSize:Math.max(1,Math.min(Number(pageSize)||20,20))
      })
    });

    const text=await r.text();
    let d={};
    try{d=text?JSON.parse(text):{}}catch{d={raw:text}}

    if(!r.ok){
      return {
        ok:false,
        configured:true,
        status:r.status,
        error:d?.error?.message||`GOOGLE_PLACES_HTTP_${r.status}`,
        places:[]
      };
    }

    return {
      ok:true,
      configured:true,
      places:Array.isArray(d?.places)?d.places:[]
    };
  }catch(e){
    return {
      ok:false,
      configured:true,
      error:String(e?.message||e||"GOOGLE_PLACES_ERROR"),
      places:[]
    };
  }
}

async function findGooglePlaceForShop(env,{name,area}){
  const sr=await googlePlacesTextSearch(env,{
    query:[name,area,"熊本県"].filter(Boolean).join(" "),
    pageSize:8
  });

  if(!sr.ok){
    return {ok:false,configured:!!sr.configured,error:sr.error,matched:false};
  }

  const ranked=(sr.places||[])
    .filter(googlePlaceLooksLikeBar)
    .map(place=>({place,score:googlePlaceScore(place,{name,area})}))
    .sort((a,b)=>b.score-a.score);

  const best=ranked[0];
  if(!best||best.score<78){
    return {ok:true,configured:true,matched:false,score:best?.score||0};
  }

  return {
    ok:true,
    configured:true,
    matched:true,
    place:best.place,
    score:best.score,
    confidence:best.score>=100?"high":"medium",
    source:"google_places"
  };
}

async function googlePlaceDetails(env,placeId){
  const cfg=googlePlacesConfig(env);
  const id=String(placeId||"").trim();
  if(!cfg.apiKey)return {ok:false,configured:false,error:"GOOGLE_PLACES_NOT_CONFIGURED",place:null};
  if(!id)return {ok:false,configured:true,error:"GOOGLE_PLACE_ID_MISSING",place:null};

  try{
    const fieldMask=[
      "id","displayName","formattedAddress","primaryType","types","businessStatus",
      "nationalPhoneNumber","internationalPhoneNumber",
      "regularOpeningHours","currentOpeningHours",
      "websiteUri","priceLevel","priceRange","googleMapsUri","photos"
    ].join(",");

    const r=await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(id)}`,{
      headers:{
        "X-Goog-Api-Key":cfg.apiKey,
        "X-Goog-FieldMask":fieldMask,
        "Accept-Language":"ja"
      }
    });

    const raw=await r.text();
    let d={};
    try{d=raw?JSON.parse(raw):{}}catch{d={raw}}

    if(!r.ok){
      return {
        ok:false,configured:true,status:r.status,
        error:d?.error?.message||`GOOGLE_PLACE_DETAILS_HTTP_${r.status}`,
        place:null
      };
    }
    return {ok:true,configured:true,place:d};
  }catch(e){
    return {ok:false,configured:true,error:String(e?.message||e||"GOOGLE_PLACE_DETAILS_ERROR"),place:null};
  }
}


// KBN Google Reviews v1.84
async function googlePlaceReviewDetails(env,placeId){
  const cfg=googlePlacesConfig(env);
  const id=String(placeId||"").trim();
  if(!cfg.apiKey){
    return {ok:false,configured:false,error:"GOOGLE_PLACES_NOT_CONFIGURED",place:null};
  }
  if(!id){
    return {ok:false,configured:true,error:"GOOGLE_PLACE_ID_MISSING",place:null};
  }

  try{
    const fieldMask=[
      "id",
      "displayName",
      "rating",
      "userRatingCount",
      "googleMapsUri",
      "googleMapsLinks",
      "reviews"
    ].join(",");

    const r=await fetch(
      `https://places.googleapis.com/v1/places/${encodeURIComponent(id)}`,
      {
        headers:{
          "X-Goog-Api-Key":cfg.apiKey,
          "X-Goog-FieldMask":fieldMask,
          "Accept-Language":"ja"
        }
      }
    );

    const raw=await r.text();
    let d={};
    try{d=raw?JSON.parse(raw):{}}catch{d={raw}};

    if(!r.ok){
      return {
        ok:false,
        configured:true,
        status:r.status,
        error:d?.error?.message||`GOOGLE_REVIEW_HTTP_${r.status}`,
        place:null
      };
    }

    return {ok:true,configured:true,place:d};
  }catch(e){
    return {
      ok:false,
      configured:true,
      error:String(e?.message||e||"GOOGLE_REVIEW_ERROR"),
      place:null
    };
  }
}

function publicGoogleReview(review){
  const a=review?.authorAttribution||{};
  return {
    rating:Number(review?.rating||0),
    text:String(review?.text?.text||review?.originalText?.text||"").slice(0,2000),
    relative_time:String(review?.relativePublishTimeDescription||""),
    publish_time:String(review?.publishTime||""),
    author:{
      name:String(a?.displayName||"Googleユーザー"),
      uri:String(a?.uri||""),
      photo_uri:String(a?.photoUri||"")
    },
    google_maps_uri:String(review?.googleMapsUri||""),
    flag_content_uri:String(review?.flagContentUri||"")
  };
}

function googleOpeningHours(place){
  const rows=place?.regularOpeningHours?.weekdayDescriptions;
  if(Array.isArray(rows)&&rows.length)return rows.join(" / ");
  const current=place?.currentOpeningHours?.weekdayDescriptions;
  if(Array.isArray(current)&&current.length)return current.join(" / ");
  return "";
}

function googleHolidayFromHours(place){
  const rows=place?.regularOpeningHours?.weekdayDescriptions;
  if(!Array.isArray(rows))return "";
  return rows
    .filter(x=>/休業|定休|closed/i.test(String(x||"")))
    .map(x=>String(x||"").split(":")[0].trim())
    .filter(Boolean)
    .join("・");
}

function googlePhone(place){
  return String(place?.nationalPhoneNumber||place?.internationalPhoneNumber||"").trim();
}

function googleWebsite(place){
  return String(place?.websiteUri||"").trim();
}

function googlePhotoName(place){
  const photos=Array.isArray(place?.photos)?place.photos:[];
  const name=String(photos[0]?.name||"").trim();
  return /^places\/[^/]+\/photos\/[^/]+$/.test(name)?name:"";
}

function googlePhotoProxyUrl(shopId,width=640){
  const w=Math.max(240,Math.min(1200,Number(width)||640));
  return `/api/shop-photo?id=${encodeURIComponent(String(shopId||""))}&w=${w}`;
}

function googlePriceInfo(place){
  const moneyToNum=(x)=>{
    if(x===null||x===undefined)return null;
    if(typeof x==="number")return Number.isFinite(x)?Math.round(x):null;
    if(typeof x==="object"){
      const units=Number(x.units||0);
      const nanos=Number(x.nanos||0);
      const v=units+nanos/1e9;
      return Number.isFinite(v)?Math.round(v):null;
    }
    const n=Number(String(x).replace(/[^\d.]/g,""));
    return Number.isFinite(n)?Math.round(n):null;
  };

  const range=place?.priceRange;
  let min=range?moneyToNum(range.startPrice||range.minPrice||range.minimumPrice):null;
  let max=range?moneyToNum(range.endPrice||range.maxPrice||range.maximumPrice):null;

  if(min===null&&max===null){
    const rough={
      PRICE_LEVEL_FREE:[0,0],
      PRICE_LEVEL_INEXPENSIVE:[500,2000],
      PRICE_LEVEL_MODERATE:[2000,5000],
      PRICE_LEVEL_EXPENSIVE:[5000,10000],
      PRICE_LEVEL_VERY_EXPENSIVE:[10000,30000]
    }[String(place?.priceLevel||"").toUpperCase()];
    if(rough){min=rough[0];max=rough[1];}
  }
  return {min,max};
}

function googleDetailFeatures(place){
  const types=googlePlaceTypes(place).map(x=>String(x).replace(/_/g," "));
  return extractFeaturesInfo(types.join(" "));
}

function findBestSecondaryForGoogle({googlePlace,fsqResults=[],geoFeatures=[],osmPlaces=[]}={}){
  const name=googlePlaceName(googlePlace);
  const address=googlePlaceAddress(googlePlace);
  const ranked=[];

  for(const p of fsqResults||[]){
    if(!fsqLooksLikeBar(p))continue;
    ranked.push({
      kind:"foursquare",
      place:p,
      score:crossSourceNameAreaScore(name,address,fsqName(p),fsqAddress(p))
    });
  }

  for(const f of geoFeatures||[]){
    if(!geoLooksLikeBar(f))continue;
    ranked.push({
      kind:"geoapify",
      place:f,
      score:crossSourceNameAreaScore(name,address,geoName(f),geoAddress(f))
    });
  }

  for(const p of osmPlaces||[]){
    if(!osmPlaceLooksLikeBar(p))continue;
    ranked.push({
      kind:"osm",
      place:p,
      score:crossSourceNameAreaScore(name,address,osmPlaceName(p),osmAddress(p))
    });
  }

  ranked.sort((a,b)=>b.score-a.score);
  const best=ranked[0];
  return best&&best.score>=82?best:null;
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

  const explicit=kbnExplicitBarSignal(text);
  const hardNonBar=kbnHardNonBarSignal(text);
  const strongType=kbnStrongNightType(`${categories.join(" ")} ${amenity}`);

  if(explicit)score+=6;
  if(strongType)score+=5;
  if(/catering\.(bar|pub)/.test(text))score+=4;
  if(/^(bar|pub|nightclub|night_club)$/.test(String(amenity||"")))score+=4;

  // 明確な非BAR業態は強く減点。
  if(hardNonBar)score-=10;

  return score;
}
function autoListingNameQuality(name){
  const s=String(name||"").trim();
  if(!s)return false;
  if(s.length<2 || s.length>80)return false;
  if(/^https?:\/\//i.test(s))return false;
  if(/^(bar|バー|pub|パブ|snack|スナック|lounge|ラウンジ)$/i.test(s))return false;
  if(/\b(?:求人|スタッフ募集|まとめ|ランキング|公式サイト)\b/i.test(s))return false;

  const explicit=kbnExplicitBarSignal(s);
  const hardNonBar=kbnHardNonBarSignal(s);

  // 居酒屋、温泉、カラオケ店などは自動掲載しない。
  // 「カラオケバー」「シーシャバー」などBARが明示される名前は通す。
  if(hardNonBar && !explicit)return false;

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


async function shopSlugExists(env,slug){
  const row=await env.DB.prepare(
    "SELECT id,name FROM shops WHERE slug=? LIMIT 1"
  ).bind(slug).first();
  return row||null;
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
  if(barStrength<6)reasons.push("BAR_CATEGORY_WEAK");
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

  const approved=!coreBlocked && confidence>=12;

  return {
    approved,
    confidence,
    reasons,
    bar_strength:barStrength,
    contact_score:contactScore
  };
}

async function autoDiscover(env,request,maxListings=20,pairLimit=15,perPairLimit=3,uniqueAreas=false){
  await ensureLeadDiscoveryTables(env);

  const osmSnap=await fetchKumamotoOsmBars(env);
  const geoSnap=await fetchKumamotoGeoapifyBars(env);
  const fsqConfigured=!!foursquareConfig(env).apiKey;
  const googleConfigured=!!googlePlacesConfig(env).apiKey;

  if(!googleConfigured&&!fsqConfigured&&!geoSnap.ok&&!osmSnap.ok){
    return {
      ok:false,error:"DISCOVERY_SOURCES_UNAVAILABLE",
      created:[],searched:[],rejected:[]
    };
  }

  const requestedPairLimit=Math.max(1,Math.min(Number(pairLimit)||15,20));
  // v2.91: uniqueAreas=true のときは autoDiscoveryPairs 側で全候補から
  // 重複のない地区を選ぶため、7地区指定なら本当に最大7地区を返す。
  let pairs=await autoDiscoveryPairs(env,requestedPairLimit,uniqueAreas);

  const created=[],searched=[],rejected=[];
  const existingR=await env.DB.prepare(
    "SELECT id,name,address,phone,instagram FROM shops"
  ).all();
  const existing=existingR.results||[];
  const deletedHistory=await loadDeletedAutoListings(env);

  for(const pair of pairs){
    if(created.length>=maxListings)break;

    const query=[pair.search_area||pair.area,"熊本県",pair.label||"BAR"].filter(Boolean).join(" ");

    const googleSearch=googleConfigured
      ? await googlePlacesTextSearch(env,{query,pageSize:20})
      : {ok:false,configured:false,places:[],error:"GOOGLE_PLACES_NOT_CONFIGURED"};

    // v2.27 Free枠対策: ペアごとのFoursquare外部fetchは停止。
    // Google + 事前取得したGeoapify/OSMを使い、1 invocation 50 subrequests以内に収める。
    const fsqSearch={ok:false,configured:fsqConfigured,results:[],error:"FOURSQUARE_SKIPPED_FREE_SAFE"};

    // v2.28: 上位4件だけでは既存店に偏るため、最大10件まで候補を見る。
    // 重複はPlace Details取得前に落とすので、subrequestは増えにくい。
    const googleCandidates=googleSearch.ok
      ? (googleSearch.places||[]).filter(googlePlaceLooksLikeBar).slice(0,15)
      : [];

    const fsqCandidates=fsqSearch.ok
      ? (fsqSearch.results||[]).filter(fsqLooksLikeBar)
      : [];

    const geoCandidates=geoSnap.ok
      ? geoSnap.features.filter(feature=>{
          const addr=geoAddress(feature);
          const hint=geoAreaHint(feature);
          return (!pair.area||addr.includes(pair.area)||hint.includes(pair.area))&&geoLooksLikeBar(feature);
        })
      : [];

    const osmCandidates=osmSnap.ok
      ? osmSnap.places.filter(place=>{
          const addr=osmAddress(place);
          const hint=osmAreaHint(place);
          return (!pair.area||addr.includes(pair.area)||hint.includes(pair.area))&&osmPlaceLooksLikeBar(place);
        })
      : [];

    searched.push({
      area:pair.search_area||pair.area,
      type:pair.label,
      ok:googleSearch.ok||fsqSearch.ok||geoSnap.ok||osmSnap.ok,
      raw_found:Array.isArray(googleSearch.places)?googleSearch.places.length:0,
      google_found:googleCandidates.length,
      fsq_found:fsqCandidates.length,
      geo_found:geoCandidates.length,
      osm_found:osmCandidates.length,
      error:googleSearch.ok?"":(googleSearch.error||""),
      source:[
        googleSearch.ok?"google_places":"",
        fsqSearch.ok?"foursquare":"",
        geoSnap.ok?"geoapify":"",
        osmSnap.ok?"osm":""
      ].filter(Boolean).join("+"),
      query
    });

    await env.DB.prepare(
      "INSERT INTO lead_discovery_runs(area,lead_type,searched_at) VALUES(?,?,CURRENT_TIMESTAMP)"
    ).bind(pair.search_area||pair.area,pair.type).run();

    let made=0;
    let detailChecks=0;
    const detailCheckLimit=Math.max(2,Math.min(4,Number(perPairLimit||3)+1));

    // --------------------------------------------------------
    // 1) Google candidates first
    // --------------------------------------------------------
    for(const g of googleCandidates){
      if(made>=perPairLimit||created.length>=maxListings)break;

      let gName=t(googlePlaceName(g),150);
      let gAddress=t(googlePlaceAddress(g),500);
      if(!gName||!gAddress)continue;
      if(!gAddress.includes("熊本")){
        rejected.push({name:gName,reason:"OUTSIDE_KUMAMOTO",source:"google_places"});
        continue;
      }

      // v2.28: Googleの基本情報だけで既存店と分かる候補はDetails取得前に除外。
      // これによりDUPLICATEが多い回でもFree枠のsubrequestを浪費しない。
      if(autoListingDuplicateScore(existing,{name:gName,address:gAddress,phone:"",instagram:""})){
        rejected.push({name:gName,reason:"DUPLICATE_EARLY",source:"google_places"});
        continue;
      }
      if(autoListingDuplicateScore(deletedHistory,{name:gName,address:gAddress,phone:"",instagram:""})){
        rejected.push({name:gName,reason:"DELETED_HISTORY_EARLY",source:"google_places"});
        continue;
      }

      // 新規候補だけPlace Detailsを少量取得。上限到達後はText Search情報で判定を続行する。
      let gDetails={ok:false,place:null,error:"DETAIL_BUDGET_SKIPPED"};
      if(detailChecks<detailCheckLimit){
        detailChecks++;
        gDetails=await googlePlaceDetails(env,g.id);
      }
      const gp=gDetails.ok&&gDetails.place?gDetails.place:g;
      gName=t(googlePlaceName(gp)||gName,150);
      gAddress=t(googlePlaceAddress(gp)||gAddress,500);

      // Find best secondary match for richer fields.
      const secondary=findBestSecondaryForGoogle({
        googlePlace:g,
        fsqResults:fsqCandidates,
        geoFeatures:geoCandidates,
        osmPlaces:osmCandidates
      });

      let sourceKind=gDetails.ok?"google_place_details":"google_places";
      let sourcePlace=null;
      let address=gAddress;
      let phone=t(googlePhone(gp)||"",80);
      let website=googleWebsite(gp);
      let instagram="";
      let hours=t(googleOpeningHours(gp)||"",800);
      let holiday=t(googleHolidayFromHours(gp)||"",180);
      let features=googleDetailFeatures(gp)||googlePlaceTypes(gp).join("、");
      let genre=/night_club|night club/.test(googlePlaceTypes(gp).join(" ").toLowerCase())
        ?"ナイトクラブ"
        :/pub/.test(googlePlaceTypes(gp).join(" ").toLowerCase())
          ?"パブ"
          :/karaoke/.test(googlePlaceTypes(gp).join(" ").toLowerCase())
            ?"カラオケBAR":"BAR";
      // v2.58 最終安全弁:
      // 店名・genre・Google typesのどこにもBAR系の明確な根拠が無い候補は掲載しない。
      const finalBarText=`${gName} ${genre} ${googlePlaceTypes(gp).join(" ")}`;
      if(kbnHardNonBarSignal(finalBarText) && !kbnExplicitBarSignal(finalBarText)){
        rejected.push({name:gName,reason:"HARD_NON_BAR",source:"google_places"});
        continue;
      }
      if(!kbnExplicitBarSignal(finalBarText) && !kbnStrongNightType(googlePlaceTypes(gp).join(" "))){
        rejected.push({name:gName,reason:"NO_EXPLICIT_BAR_SIGNAL",source:"google_places"});
        continue;
      }

      let sourceCount=1;
      let matchScore=googlePlaceScore(g,{name:gName,area:pair.area});

      if(secondary){
        sourceKind=`${gDetails.ok?"google_place_details":"google_places"}+${secondary.kind}`;
        sourceCount=2;
        matchScore=Math.max(matchScore,Number(secondary.score||0));
        sourcePlace=secondary.place;

        if(secondary.kind==="foursquare"){
          address=fsqAddress(sourcePlace)||address;
          phone=phone||fsqPhone(sourcePlace)||"";
          website=website||fsqWebsite(sourcePlace)||"";
          instagram=fsqInstagram(sourcePlace)||"";
          hours=hours||fsqHours(sourcePlace)||"";
          features=extractFeaturesInfo(`${fsqCategories(sourcePlace).join(" ")} ${gName}`)||features;
        }else if(secondary.kind==="geoapify"){
          address=geoAddress(sourcePlace)||address;
          phone=phone||geoPhone(sourcePlace)||"";
          website=website||geoWebsite(sourcePlace)||"";
          instagram=geoInstagram(sourcePlace)||"";
          hours=hours||geoHours(sourcePlace)||"";
          features=extractFeaturesInfo(`${geoCategories(sourcePlace).join(" ")} ${gName}`)||features;
        }else if(secondary.kind==="osm"){
          address=osmAddress(sourcePlace)||address;
          phone=phone||osmPhone(sourcePlace)||"";
          website=website||osmWebsite(sourcePlace)||"";
          instagram=osmInstagram(sourcePlace)||"";
          hours=hours||osmHours(sourcePlace)||"";
          holiday=holiday||osmHoliday(sourcePlace)||"";
          features=osmFeatures(sourcePlace)||features;
        }
      }

      if(autoListingDuplicateScore(existing,{
        name:gName,address,phone,instagram
      })){
        rejected.push({name:gName,reason:"DUPLICATE",source:sourceKind});
        continue;
      }
      if(autoListingDuplicateScore(deletedHistory,{
        name:gName,address,phone,instagram
      })){
        rejected.push({name:gName,reason:"DELETED_HISTORY",source:sourceKind});
        continue;
      }

      const area=inferKumamotoAreaFromText(address,pair.area);
      const gate=strictAutoListingGate({
        name:gName,
        area,
        address,
        genre,
        // v2.28: 検索カテゴリ自体も補助シグナルとして利用（Google候補は既にBAR系判定済み）。
        categories:[...googlePlaceTypes(g),pair.label,pair.type],
        amenity:"",
        phone,
        website,
        instagram,
        sourceMatchScore:matchScore,
        sourceCount
      });

      // Google itself is trusted for existence/address/type.
      // Secondary source increases confidence but is not mandatory.
      if(sourceCount>=2)gate.confidence+=2;
      if(!gate.approved){
        const coreBlocked=gate.reasons.some(r=>
          ["NAME_WEAK","ADDRESS_NOT_CONFIRMED","BAR_CATEGORY_WEAK"].includes(r)
        );
        if(!coreBlocked && googlePlaceLooksLikeBar(g) && gAddress.includes("熊本")){
          gate.approved=true;
        }
      }

      if(!gate.approved){
        rejected.push({
          name:gName,area,
          reason:gate.reasons.join(",")||"LOW_CONFIDENCE",
          confidence:gate.confidence,
          source:sourceKind
        });
        continue;
      }

      // v2.27 Free枠対策: 自動掲載の同一invocation内では公式サイト/Instagramの追加fetchをしない。
      // まず掲載を成立させ、情報補完は通常メンテナンス側で少量ずつ行う。
      const webMeta={ok:false,price:{min:null,max:null},hours:"",holiday:"",features:"",instagram:""};

      const googlePrice=googlePriceInfo(gp);
      let sourceMin=googlePrice.min,sourceMax=googlePrice.max;
      if(sourcePlace){
        if(secondary?.kind==="foursquare"){
          const p=extractPriceInfo(JSON.stringify(sourcePlace));
          sourceMin=p.min; sourceMax=p.max;
        }else if(secondary?.kind==="geoapify"){
          const p=extractPriceInfo(JSON.stringify(geoFeatureProps(sourcePlace)));
          sourceMin=p.min; sourceMax=p.max;
        }else if(secondary?.kind==="osm"){
          const p=extractPublicMetadata(sourcePlace);
          sourceMin=p.budget_min; sourceMax=p.budget_max;
        }
      }

      const finalHours=hours||webMeta.hours||"";
      const finalHoliday=holiday||webMeta.holiday||"";
      const finalFeatures=[features,webMeta.features].filter(Boolean).join("、");
      const budgetMin=webMeta.price?.min??sourceMin??null;
      const budgetMax=webMeta.price?.max??sourceMax??null;

      const desc=
        "※本ページは、公開されている店舗情報をもとにKUMAMOTO BAR NAVIが独自に掲載しています。"+
        "掲載内容の修正・削除をご希望の場合は店舗様専用ページよりご連絡ください。";

      const slug=slugify(gName);

      const slugExisting=await shopSlugExists(env,slug);
      if(slugExisting){
        rejected.push({
          name:gName,area,reason:"DUPLICATE_SLUG",source:sourceKind,
          existing_shop_id:Number(slugExisting.id||0)
        });
        continue;
      }

      const ins=await env.DB.prepare(`
        INSERT INTO shops(
          slug,name,name_kana,area,address,hours,holiday,instagram,genre,features,description,
          budget_min,budget_max,seats,phone,is_recruiting,is_published,image_url,image_key,
          is_featured,is_new,sort_order,listing_status,published_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'provisional',CURRENT_TIMESTAMP)
      `).bind(
        slug,gName,"",area,address,finalHours,finalHoliday,instagram,
        genre,finalFeatures,desc,budgetMin,budgetMax,null,phone,
        0,1,"","",0,1,100
      ).run();

      const id=Number(ins.meta?.last_row_id||0);
      const token=ownerToken(),hash=await sha256hex(token);
      await env.DB.prepare(
        "UPDATE shops SET owner_token_hash=?,owner_token_created_at=CURRENT_TIMESTAMP WHERE id=?"
      ).bind(hash,id).run();

      const autoPhotoName=googlePhotoName(gp);
      if(autoPhotoName){
        await env.DB.prepare("UPDATE shops SET image_url=?,image_key=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
          .bind(googlePhotoProxyUrl(id),`google:${autoPhotoName}`,id).run();
      }

      existing.push({id,name:gName,address,phone,instagram});

      const origin=new URL(request.url).origin;
      created.push({
        shop_id:id,
        name:gName,
        area,genre,address,phone,
        hours:finalHours,holiday:finalHoliday,
        budget_min:budgetMin,budget_max:budgetMax,
        auto_confidence:gate.confidence,
        source_count:sourceCount,
        source:sourceKind,
        google_place_id:String(g.id||""),
        public_url:`${origin}/shop?slug=${encodeURIComponent(slug)}`
      });
      made++;
    }

    // v2.28 診断用: 実際にDetailsへ進んだ件数を記録。
    if(searched.length){
      searched[searched.length-1].detail_checks=detailChecks;
      searched[searched.length-1].candidate_scan_count=googleCandidates.length;
    }

    // --------------------------------------------------------
    // 2) Google unavailable/no candidates -> secondary fallback
    // --------------------------------------------------------
    if(made<perPairLimit && created.length<maxListings && !googleCandidates.length){
      const fallback=[
        ...fsqCandidates.map(place=>({kind:"foursquare",place})),
        ...geoCandidates.map(place=>({kind:"geoapify",place})),
        ...osmCandidates.map(place=>({kind:"osm",place}))
      ];

      for(const item of fallback){
        if(made>=perPairLimit||created.length>=maxListings)break;

        const isFsq=item.kind==="foursquare";
        const isGeo=item.kind==="geoapify";
        const place=item.place;
        const name=t(isFsq?fsqName(place):(isGeo?geoName(place):osmPlaceName(place)),150);
        const address=t(isFsq?fsqAddress(place):(isGeo?geoAddress(place):osmAddress(place)),500);
        const phone=t(isFsq?fsqPhone(place):(isGeo?geoPhone(place):osmPhone(place)),80);
        const website=isFsq?fsqWebsite(place):(isGeo?geoWebsite(place):osmWebsite(place));
        let instagram=isFsq?fsqInstagram(place):(isGeo?geoInstagram(place):osmInstagram(place));
        if(!name||!address||!address.includes("熊本"))continue;

        // v2.27 Free枠対策: Instagram探索は後続メンテナンスへ回す。

        if(autoListingDuplicateScore(existing,{name,address,phone,instagram}))continue;
        if(autoListingDuplicateScore(deletedHistory,{name,address,phone,instagram})){
          rejected.push({name,reason:"DELETED_HISTORY",source:item.kind});
          continue;
        }

        const slug=slugify(name);
        if(await shopSlugExists(env,slug)){
          rejected.push({name,reason:"DUPLICATE_SLUG",source:item.kind});
          continue;
        }

        const categories=isFsq?fsqCategories(place):(isGeo?geoCategories(place):[]);
        const amenity=(isFsq||isGeo)?"":String(osmTags(place).amenity||"");
        const genre=t(
          isFsq?(categories.some(x=>/pub|パブ/i.test(x))?"パブ":"BAR")
          :isGeo?(categories.some(x=>x==="catering.pub")?"パブ":"BAR")
          :(amenity==="pub"?"パブ":amenity==="nightclub"?"ナイトクラブ":"BAR"),
          120
        );

        const gate=strictAutoListingGate({
          name,area:pair.area,address,genre,categories,amenity,
          phone,website,instagram,sourceMatchScore:90,sourceCount:1
        });
        if(!gate.approved)continue;

        const sourceHours=isFsq?fsqHours(place):(isGeo?geoHours(place):osmHours(place));
        const sourceHoliday=(isFsq||isGeo)?"":osmHoliday(place);
        const sourceFeatures=isFsq
          ? extractFeaturesInfo(`${categories.join(" ")} ${name}`)
          :isGeo
            ? extractFeaturesInfo(`${categories.join(" ")} ${name}`)
            :osmFeatures(place);

        const webMeta={ok:false,price:{min:null,max:null},hours:"",holiday:"",features:""};

        const sourcePrice=isFsq
          ? extractPriceInfo(JSON.stringify(place))
          :isGeo
            ? extractPriceInfo(JSON.stringify(geoFeatureProps(place)))
            :extractPublicMetadata(place);

        const sourceMin=(isFsq||isGeo)?sourcePrice.min:sourcePrice.budget_min;
        const sourceMax=(isFsq||isGeo)?sourcePrice.max:sourcePrice.budget_max;

        const area=inferKumamotoAreaFromText(address,pair.area);
        const finalHours=sourceHours||webMeta.hours||"";
        const finalHoliday=sourceHoliday||webMeta.holiday||"";
        const finalFeatures=[sourceFeatures,webMeta.features].filter(Boolean).join("、");
        const budgetMin=webMeta.price?.min??sourceMin??null;
        const budgetMax=webMeta.price?.max??sourceMax??null;

        const desc=
          "※本ページは、公開されている店舗情報をもとにKUMAMOTO BAR NAVIが独自に掲載しています。"+
          "掲載内容の修正・削除をご希望の場合は店舗様専用ページよりご連絡ください。";

        const ins=await env.DB.prepare(`
          INSERT INTO shops(
            slug,name,name_kana,area,address,hours,holiday,instagram,genre,features,description,
            budget_min,budget_max,seats,phone,is_recruiting,is_published,image_url,image_key,
            is_featured,is_new,sort_order,listing_status,published_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'provisional',CURRENT_TIMESTAMP)
        `).bind(
          slug,name,"",area,address,finalHours,finalHoliday,instagram,
          genre,finalFeatures,desc,budgetMin,budgetMax,null,phone,
          0,1,"","",0,1,100
        ).run();

        const id=Number(ins.meta?.last_row_id||0);
        const token=ownerToken(),hash=await sha256hex(token);
        await env.DB.prepare(
          "UPDATE shops SET owner_token_hash=?,owner_token_created_at=CURRENT_TIMESTAMP WHERE id=?"
        ).bind(hash,id).run();

        existing.push({id,name,address,phone,instagram});
        const origin=new URL(request.url).origin;
        created.push({
          shop_id:id,name,area,genre,address,phone,
          hours:finalHours,holiday:finalHoliday,
          budget_min:budgetMin,budget_max:budgetMax,
          auto_confidence:gate.confidence,
          source_count:1,
          source:item.kind,
          public_url:`${origin}/shop?slug=${encodeURIComponent(slug)}`
        });
        made++;
      }
    }
  }

  const rejectSummary=rejected.reduce((acc,x)=>{
    const k=String(x.reason||"UNKNOWN");
    acc[k]=(acc[k]||0)+1;
    return acc;
  },{});

  return {
    ok:true,
    created,
    searched,
    rejected:rejected.slice(0,100),
    rejected_count:rejected.length,
    reject_summary:rejectSummary,
    provider:googleConfigured
      ?"google_places_foursquare_geoapify_osm"
      :(fsqConfigured?"foursquare_geoapify_osm":"geoapify_osm"),
    google_configured:googleConfigured,
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

// KBN structured data SEO complete v260
function kbnSchemaAbsUrl(v,origin){
  const s=String(v||"").trim();
  if(!s)return "";
  try{return new URL(s,origin).toString();}catch{return "";}
}
function kbnSeoImageData(shop,{origin,canonical,name,area,genre}={}){
  const raw=String(shop?.image_url||"").trim();
  const url=kbnSchemaAbsUrl(raw,origin);
  if(!url)return null;
  const safeName=String(name||kbnCleanShopName(shop?.name)||"店舗").trim();
  const safeArea=String(area||shop?.area||"熊本").trim()||"熊本";
  const safeGenre=String(genre||shop?.genre||"BAR").trim()||"BAR";
  const alt=`${safeName}｜${safeArea}の${safeGenre}`.slice(0,120);
  return {
    url,alt,
    object:{
      "@type":"ImageObject",
      ...(canonical?{"@id":`${canonical}#primaryimage`}:{}),
      "url":url,"contentUrl":url,"caption":alt,"name":alt,
      "representativeOfPage":true
    }
  };
}
function kbnSchemaSiteNodes(origin){
  const orgId=`${origin}/#organization`, siteId=`${origin}/#website`;
  return [
    {
      "@type":"Organization","@id":orgId,"name":"KUMAMOTO BAR NAVI","url":`${origin}/`,
      "logo":{"@type":"ImageObject","url":`${origin}/logo.png`}
    },
    {
      "@type":"WebSite","@id":siteId,"url":`${origin}/`,"name":"KUMAMOTO BAR NAVI","inLanguage":"ja-JP",
      "publisher":{"@id":orgId},
      "potentialAction":{"@type":"SearchAction","target":{"@type":"EntryPoint","urlTemplate":`${origin}/bars.html?keyword={search_term_string}`},"query-input":"required name=search_term_string"}
    }
  ];
}
function kbnSchemaShopNode(shop,{origin,canonical,name,area,genre,description,budget,featureList=[]}){
  const imageData=kbnSeoImageData(shop,{origin,canonical,name,area,genre});
  const instagram=String(shop?.instagram||"").trim();
  const sameAs=[];
  if(/^https?:\/\//i.test(instagram))sameAs.push(instagram);
  else if(/^@?[A-Za-z0-9._]+$/.test(instagram))sameAs.push(`https://www.instagram.com/${instagram.replace(/^@/,"")}/`);
  const amenities=(featureList||[]).slice(0,12).map(x=>({"@type":"LocationFeatureSpecification","name":String(x),"value":true}));
  return {
    "@type":["BarOrPub","LocalBusiness"],
    "@id":`${canonical}#business`,
    "name":name,"url":canonical,"description":description,
    "mainEntityOfPage":{"@id":canonical},
    ...(imageData?{"image":[imageData.object]}:{}),
    ...(shop?.phone?{"telephone":String(shop.phone)}:{}),
    ...(shop?.address?{"address":{"@type":"PostalAddress","streetAddress":String(shop.address),"addressLocality":String(area||"熊本"),"addressRegion":"熊本県","addressCountry":"JP"}}:{}),
    ...(shop?.hours?{"openingHours":String(shop.hours)}:{}),
    ...(budget?{"priceRange":budget,"currenciesAccepted":"JPY"}:{}),
    ...(genre?{"category":String(genre)}:{}),
    ...(amenities.length?{"amenityFeature":amenities}:{}),
    ...(sameAs.length?{"sameAs":sameAs}:{})
  };
}


// Structured data self-check v270
function kbnStructuredDataAudit(shop,origin){
  const slug=String(shop?.slug||"").trim();
  const name=kbnCleanShopName(shop?.name)||"";
  const area=String(shop?.area||"熊本").trim()||"熊本";
  const genre=String(shop?.genre||"BAR").trim()||"BAR";
  const canonical=`${origin}/shop?slug=${encodeURIComponent(slug)}`;
  const featureList=String(shop?.features||"").split(/[、,\\/｜|・\\n]+/).map(x=>x.trim()).filter(Boolean).slice(0,8);
  const budget=kbnBudget(shop);
  const rawDesc=String(shop?.description||"").replace(/※本ページ[\\s\\S]*/g,"").replace(/\\s+/g," ").trim();
  const description=[`${area}の${genre}「${name}」の店舗情報`,rawDesc?rawDesc.slice(0,82):"",shop?.address?`住所 ${String(shop.address).trim()}`:"",shop?.hours?`営業時間 ${String(shop.hours).trim()}`:"",budget?`料金目安 ${budget}`:""].filter(Boolean).join("。").slice(0,158);
  const node=kbnSchemaShopNode(shop,{origin,canonical,name,area,genre,description,budget,featureList});
  const errors=[],warnings=[],passed=[];
  const req=(ok,label,msg)=>{if(ok)passed.push(label);else errors.push(msg||label)};
  const warn=(ok,msg)=>{if(!ok)warnings.push(msg)};
  req(slug,'固有URL','slugがありません');
  req(name,'店舗名','店舗名がありません');
  req(canonical.startsWith('https://'),'canonical','canonical URLが不正です');
  req(Array.isArray(node['@type'])&&node['@type'].includes('BarOrPub'),'BarOrPub','BarOrPub型がありません');
  req(node['@id']===`${canonical}#business`,'@id','店舗@idがcanonicalと一致していません');
  req(node.url===canonical,'URL一致','構造化データURLがcanonicalと一致していません');
  req(Boolean(node.description)&&String(node.description).length>=50,'説明文','構造化データの説明文が短すぎます');
  warn(Boolean(node.address),'住所が未設定です。LocalBusiness理解のため補完推奨');
  warn(Boolean(node.openingHours),'営業時間が未設定です');
  warn(Boolean(node.telephone),'電話番号が未設定です');
  warn(Boolean(node.image&&node.image.length),'画像が未設定です');
  warn(Boolean(node.priceRange),'料金目安が未設定です');
  warn(Boolean(node.sameAs&&node.sameAs.length),'Instagram等のsameAsが未設定です');
  if(node.address){
    warn(node.address.addressCountry==='JP','addressCountry が JP ではありません');
    warn(Boolean(node.address.addressRegion),'addressRegion が未設定です');
  }
  const max=100;
  let score=max-errors.length*20-warnings.length*5;
  score=Math.max(0,Math.min(100,score));
  return {score,errors,warnings,passed,canonical,node};
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
  let total=0;
  let updatedAt="";
  try{
    const [listRes,countRes]=await Promise.all([
      env.DB.prepare(`
        SELECT slug,name,area,address,hours,holiday,genre,features,budget_min,budget_max,image_url,
               listing_status,is_recruiting,description,updated_at
        FROM shops
        WHERE COALESCE(is_published,1)=1 AND area=? AND COALESCE(slug,'')<>''
        ORDER BY COALESCE(is_featured,0) DESC, COALESCE(sort_order,100) ASC, updated_at DESC
        LIMIT 120
      `).bind(area).all(),
      env.DB.prepare(`
        SELECT COUNT(*) AS total, MAX(updated_at) AS updated_at
        FROM shops
        WHERE COALESCE(is_published,1)=1 AND area=? AND COALESCE(slug,'')<>''
      `).bind(area).first()
    ]);
    shops=listRes.results||[];
    total=Number(countRes?.total||shops.length||0);
    updatedAt=String(countRes?.updated_at||shops[0]?.updated_at||"");
  }catch(e){ console.error("local seo area query",e); }

  const canonical=`https://kumamoto-bar-navi.rrwpvwmz8p.workers.dev/area/${slug}`;
  const indexable=total>0;
  const shownCount=shops.length;

  const genreCounts=new Map();
  let hoursCount=0,addressCount=0,recruitCount=0,budgetCount=0,budgetSum=0,descCount=0;
  for(const s of shops){
    const genre=String(s.genre||"").trim();
    if(genre){
      for(const raw of genre.split(/[、,／/・|]/).map(x=>x.trim()).filter(Boolean).slice(0,3)){
        genreCounts.set(raw,(genreCounts.get(raw)||0)+1);
      }
    }
    if(String(s.hours||"").trim())hoursCount++;
    if(String(s.address||"").trim())addressCount++;
    if(Number(s.is_recruiting||0)===1)recruitCount++;
    if(String(s.description||"").trim())descCount++;
    const lo=Number(s.budget_min||0), hi=Number(s.budget_max||0);
    const mid=lo&&hi?(lo+hi)/2:(lo||hi||0);
    if(mid>0){budgetCount++;budgetSum+=mid;}
  }
  const topGenres=[...genreCounts.entries()].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0],'ja')).slice(0,6);
  const avgBudget=budgetCount?Math.round((budgetSum/budgetCount)/100)*100:0;
  const updateDate=updatedAt?String(updatedAt).slice(0,10).replace(/-/g,"/"):"";
  const topGenreText=topGenres.slice(0,3).map(x=>x[0]).join("・");

  const title=`${area}のBAR・バー${total?` ${total}店舗`:""}｜営業時間・料金・ジャンルから探す｜KUMAMOTO BAR NAVI`;
  const description=indexable
    ? `${area}のBAR・バーを${total}店舗掲載。${topGenreText?`${topGenreText}などのジャンル、`:""}営業時間、料金目安、住所、求人情報を比較して今夜行きたい一軒を探せます。KUMAMOTO BAR NAVIが公開店舗情報を随時更新しています。`
    : `${area}のBAR・バー情報を掲載するKUMAMOTO BAR NAVIのエリアページです。`;

  const cards=shops.map(s=>{
    const name=kbnCleanShopName(s.name)||"BAR";
    const budget=kbnBudget(s);
    const features=String(s.features||"").split(/[、,／/・|]/).map(x=>x.trim()).filter(Boolean).slice(0,3);
    return `<article class="local-seo-card">
      <a href="/shop?slug=${encodeURIComponent(s.slug||"")}">
        <div class="local-seo-img">${s.image_url?`<img src="${kbnSeoEsc(s.image_url)}" alt="${kbnSeoEsc(name)}｜${kbnSeoEsc(area)}のBAR" loading="lazy" decoding="async" fetchpriority="low">`:`<img src="/default-bar.svg" alt="" loading="lazy" decoding="async" fetchpriority="low">`}</div>
        <div class="local-seo-body">
          <div class="local-seo-meta"><span>${kbnSeoEsc(s.genre||"BAR")}</span>${s.listing_status==="provisional"?"<small>KBN独自掲載</small>":""}</div>
          <h2>${kbnSeoEsc(name)}</h2>
          ${s.address?`<p>${kbnSeoEsc(s.address)}</p>`:""}
          ${features.length?`<div class="kbn-area-tags">${features.map(f=>`<span>${kbnSeoEsc(f)}</span>`).join("")}</div>`:""}
          <div class="local-seo-facts">
            ${s.hours?`<span><small>営業時間</small><b>${kbnSeoEsc(s.hours)}</b></span>`:""}
            ${budget?`<span><small>料金目安</small><b>${kbnSeoEsc(budget)}</b></span>`:""}
          </div>
          <div class="local-seo-bottom">${Number(s.is_recruiting||0)===1?`<em>求人あり</em>`:""}<b>店舗詳細を見る →</b></div>
        </div>
      </a>
    </article>`;
  }).join("");

  const facts=[];
  facts.push(`<div><strong>${total}</strong><span>掲載店舗</span></div>`);
  if(hoursCount)facts.push(`<div><strong>${hoursCount}</strong><span>営業時間掲載</span></div>`);
  if(recruitCount)facts.push(`<div><strong>${recruitCount}</strong><span>求人あり</span></div>`);
  if(avgBudget)facts.push(`<div><strong>約¥${avgBudget.toLocaleString()}</strong><span>料金目安平均*</span></div>`);

  const genreLinks=topGenres.map(([genre,count])=>{
    const genreSlug=kbnGenreSlugForText(genre);
    const href=genreSlug&&count>=5?`/area/${encodeURIComponent(slug)}/${encodeURIComponent(genreSlug)}`:`/bars.html?area=${encodeURIComponent(area)}&genre=${encodeURIComponent(genre)}`;
    return `<a href="${href}"><b>${kbnSeoEsc(genre)}</b><span>${count}店舗</span></a>`;
  }).join("");

  const areaGuideParts=[];
  if(total)areaGuideParts.push(`${area}では現在${total}店舗のBAR・バーを掲載しています。`);
  if(topGenreText)areaGuideParts.push(`掲載データでは${topGenreText}などのジャンルを探せます。`);
  if(hoursCount)areaGuideParts.push(`${hoursCount}店舗で営業時間を確認できるため、来店前の比較にも使えます。`);
  if(recruitCount)areaGuideParts.push(`求人情報が登録されている店舗は${recruitCount}店舗あります。`);
  areaGuideParts.push(`店舗ごとの最新情報は詳細ページで確認し、営業時間や料金など重要な情報は来店前に店舗へ直接確認することをおすすめします。`);
  const areaGuide=areaGuideParts.join("");

  const faq=[
    [`${area}のBARは何店舗掲載されていますか？`,indexable?`現在${total}店舗を掲載しています。掲載店舗数は公開データに合わせて自動更新されます。`:`現在掲載準備中です。`],
    [`${area}のBARをジャンルから探せますか？`,topGenreText?`${topGenreText}など、登録されているジャンルから絞り込めます。`:`BAR一覧の検索機能からジャンルを指定できます。`],
    [`${area}のBARの営業時間や料金は確認できますか？`,`店舗から公開されている情報がある場合、各店舗ページで営業時間、料金目安、住所などを確認できます。`],
    [`${area}のBAR求人も探せますか？`,recruitCount?`現在${recruitCount}店舗で求人情報が登録されています。求人ページから詳細を確認できます。`:`求人情報が登録された店舗は求人ページに表示されます。`]
  ];

  const itemList=shops.slice(0,100).map((s,i)=>({"@type":"ListItem","position":i+1,"name":kbnCleanShopName(s.name),"url":`https://kumamoto-bar-navi.rrwpvwmz8p.workers.dev/shop?slug=${encodeURIComponent(s.slug||"")}`}));
  const areaOrigin="https://kumamoto-bar-navi.rrwpvwmz8p.workers.dev";
  const jsonLd={"@context":"https://schema.org","@graph":[
    ...kbnSchemaSiteNodes(areaOrigin),
    {"@type":"CollectionPage","@id":canonical,"name":`${area}のBAR・バー一覧`,"url":canonical,"description":description,"inLanguage":"ja-JP","isPartOf":{"@id":`${areaOrigin}/#website`},"publisher":{"@id":`${areaOrigin}/#organization`},"mainEntity":{"@id":`${canonical}#items`}},
    {"@type":"BreadcrumbList","itemListElement":[
      {"@type":"ListItem","position":1,"name":"ホーム","item":"https://kumamoto-bar-navi.rrwpvwmz8p.workers.dev/"},
      {"@type":"ListItem","position":2,"name":"エリアから探す","item":"https://kumamoto-bar-navi.rrwpvwmz8p.workers.dev/areas.html"},
      {"@type":"ListItem","position":3,"name":area,"item":canonical}
    ]},
    {"@type":"ItemList","@id":`${canonical}#items`,"name":`${area}のBAR一覧`,"numberOfItems":total,"itemListElement":itemList},
    {"@type":"FAQPage","mainEntity":faq.map(x=>({"@type":"Question","name":x[0],"acceptedAnswer":{"@type":"Answer","text":x[1]}}))}
  ]};

  const robots=indexable?"index,follow,max-image-preview:large":"noindex,follow";
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${kbnSeoEsc(title)}</title><meta name="description" content="${kbnSeoEsc(description)}"><link rel="canonical" href="${canonical}">
<meta property="og:type" content="website"><meta property="og:title" content="${kbnSeoEsc(title)}"><meta property="og:description" content="${kbnSeoEsc(description)}"><meta property="og:url" content="${canonical}">
<meta name="twitter:card" content="summary_large_image"><meta name="robots" content="${robots}"><link rel="stylesheet" href="/style.css?v=210">
<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g,"\\u003c")}</script>
<style>
.kbn-area-stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:22px 0}.kbn-area-stats>div{padding:16px;border:1px solid rgba(255,255,255,.12);border-radius:16px;background:rgba(255,255,255,.035)}.kbn-area-stats strong{display:block;font-size:1.45rem}.kbn-area-stats span{font-size:.78rem;opacity:.7}.kbn-area-genres{display:flex;gap:10px;overflow:auto;padding:4px 0 10px}.kbn-area-genres a{min-width:145px;padding:14px;border:1px solid rgba(255,255,255,.12);border-radius:14px;text-decoration:none;color:inherit;background:rgba(255,255,255,.035)}.kbn-area-genres b,.kbn-area-genres span{display:block}.kbn-area-genres span{font-size:.78rem;opacity:.68;margin-top:4px}.kbn-area-tags{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}.kbn-area-tags span{font-size:.72rem;padding:4px 7px;border-radius:999px;background:rgba(255,255,255,.06)}.kbn-area-updated{font-size:.78rem;opacity:.62;margin-top:10px}.kbn-area-note{font-size:.74rem;opacity:.58;margin-top:8px}@media(min-width:720px){.kbn-area-stats{grid-template-columns:repeat(4,minmax(0,1fr))}}
</style></head>
<body class="public-v109 local-seo-page">
<header class="public-header"><div class="container public-header-inner"><a class="public-brand" href="/"><img src="/logo.png" alt="KUMAMOTO BAR NAVI"><span><b>KUMAMOTO</b><strong>BAR NAVI</strong><small>BAR & JOB INFORMATION</small></span></a><nav class="public-desktop-nav"><a href="/bars.html">BARを探す</a><a href="/areas.html" class="active">エリア</a><a href="/jobs.html">求人</a><a href="/column.html">コラム</a></nav><a class="public-header-cta" href="/bars.html">BARを探す</a></div></header>
<main><section class="local-seo-hero"><div class="container"><nav class="local-seo-breadcrumb"><a href="/">ホーム</a><span>›</span><a href="/areas.html">エリア</a><span>›</span><b>${kbnSeoEsc(area)}</b></nav><p class="public-kicker">KUMAMOTO AREA GUIDE</p><h1>${kbnSeoEsc(area)}のBAR・バー</h1><p>${indexable?`${kbnSeoEsc(area)}で今夜行きたいBARを${total}店舗から探せます。店舗ごとの営業時間・料金・ジャンル・特徴を比較して、自分に合う一軒を見つけてください。`:`${kbnSeoEsc(area)}のBAR情報を順次追加しています。`}</p>${indexable?`<div class="kbn-area-stats">${facts.join("")}</div>${avgBudget?`<p class="kbn-area-note">* 料金情報が登録されている掲載店舗の目安値から算出。</p>`:""}`:""}${updateDate?`<p class="kbn-area-updated">掲載情報 最終更新：${kbnSeoEsc(updateDate)}</p>`:""}</div></section>
${topGenres.length?`<section class="local-seo-guide"><div class="container"><p class="public-kicker">POPULAR GENRES</p><h2>${kbnSeoEsc(area)}で探せるジャンル</h2><div class="kbn-area-genres">${genreLinks}</div></div></section>`:""}
<section class="local-seo-list"><div class="container"><div class="local-seo-head"><div><p class="public-kicker">BAR LIST</p><h2>${kbnSeoEsc(area)}のBAR一覧</h2></div><a href="/bars.html?area=${encodeURIComponent(area)}">条件を指定して探す →</a></div>${shops.length?`<div class="local-seo-grid">${cards}</div>${total>shownCount?`<p class="kbn-area-note">このページでは代表的な${shownCount}店舗を表示しています。全店舗は「条件を指定して探す」から確認できます。</p>`:""}`:`<div class="local-seo-empty"><h2>${kbnSeoEsc(area)}の掲載店舗を準備中です</h2><p>店舗情報を順次追加しています。</p></div>`}</div></section>
<section class="local-seo-guide"><div class="container"><p class="public-kicker">AREA GUIDE</p><h2>${kbnSeoEsc(area)}でBARを探すポイント</h2><p>${kbnSeoEsc(areaGuide)}</p></div></section>
<section class="local-seo-faq"><div class="container"><p class="public-kicker">FAQ</p><h2>${kbnSeoEsc(area)}のBAR探し よくある質問</h2><div>${faq.map(x=>`<details><summary>${kbnSeoEsc(x[0])}</summary><p>${kbnSeoEsc(x[1])}</p></details>`).join("")}</div></div></section>
</main><nav class="public-bottom-nav"><a href="/"><span>⌂</span><b>ホーム</b></a><a href="/bars.html"><span>⌕</span><b>BARを探す</b></a><a href="/jobs.html"><span>▣</span><b>求人</b></a><a href="/listing-form.html"><span>＋</span><b>店舗掲載</b></a></nav></body></html>`;
}


const KBN_LOCAL_SEO_GENRES={
  "darts-bar":{label:"ダーツバー",terms:["ダーツ","darts"]},
  "karaoke-bar":{label:"カラオケバー",terms:["カラオケ","karaoke"]},
  "snack":{label:"スナック",terms:["スナック","snack"]},
  "lounge":{label:"ラウンジ",terms:["ラウンジ","lounge"]},
  "shisha-bar":{label:"シーシャバー",terms:["シーシャ","shisha"]},
  "sports-bar":{label:"スポーツバー",terms:["スポーツ","sports"]},
  "wine-bar":{label:"ワインバー",terms:["ワイン","wine"]},
  "music-bar":{label:"ミュージックバー",terms:["ミュージック","music","ライブ"]},
  "one-person":{label:"一人飲みにおすすめのBAR",terms:["一人","ひとり","おひとり","一人飲み"]},
  "all-you-can-drink":{label:"飲み放題があるBAR",terms:["飲み放題","フリードリンク"]},
  "late-night":{label:"深夜営業のBAR",terms:["深夜","翌","24:","25:","26:","27:","28:","29:"]}
};

async function renderLocalSeoGenrePage(env,slug){
  const cfg=KBN_LOCAL_SEO_GENRES[slug];
  if(!cfg)return null;
  const terms=cfg.terms||[];
  const like=terms.map(()=>`LOWER(COALESCE(genre,'') || ' ' || COALESCE(features,'') || ' ' || COALESCE(description,'') || ' ' || COALESCE(hours,'')) LIKE ?`).join(' OR ');
  const binds=terms.map(t=>`%${String(t).toLowerCase()}%`);
  let shops=[],total=0,updatedAt='';
  try{
    const [lr,cr]=await Promise.all([
      env.DB.prepare(`SELECT slug,name,area,address,hours,holiday,genre,features,budget_min,budget_max,image_url,listing_status,is_recruiting,description,updated_at FROM shops WHERE COALESCE(is_published,1)=1 AND COALESCE(slug,'')<>'' AND (${like}) ORDER BY COALESCE(is_featured,0) DESC, COALESCE(sort_order,100) ASC, updated_at DESC LIMIT 120`).bind(...binds).all(),
      env.DB.prepare(`SELECT COUNT(*) AS total, MAX(updated_at) AS updated_at FROM shops WHERE COALESCE(is_published,1)=1 AND COALESCE(slug,'')<>'' AND (${like})`).bind(...binds).first()
    ]);
    shops=lr.results||[]; total=Number(cr?.total||shops.length||0); updatedAt=String(cr?.updated_at||shops[0]?.updated_at||'');
  }catch(e){console.error('local seo genre query',slug,e)}
  const label=cfg.label, canonical=`https://kumamoto-bar-navi.rrwpvwmz8p.workers.dev/genre/${slug}`;
  const indexable=total>=3;
  const areaCounts=new Map(); let hoursCount=0,budgetCount=0,budgetSum=0,recruitCount=0;
  for(const s of shops){ const a=String(s.area||'').trim(); if(a)areaCounts.set(a,(areaCounts.get(a)||0)+1); if(String(s.hours||'').trim())hoursCount++; if(Number(s.is_recruiting||0)===1)recruitCount++; const lo=Number(s.budget_min||0),hi=Number(s.budget_max||0),mid=lo&&hi?(lo+hi)/2:(lo||hi||0); if(mid){budgetCount++;budgetSum+=mid;} }
  const topAreas=[...areaCounts.entries()].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0],'ja')).slice(0,8);
  const avgBudget=budgetCount?Math.round((budgetSum/budgetCount)/100)*100:0;
  const updateDate=updatedAt?updatedAt.slice(0,10).replace(/-/g,'/'):'';
  const title=`熊本の${label}${total?` ${total}店舗`:''}｜エリア・営業時間・料金から探す｜KUMAMOTO BAR NAVI`;
  const description=indexable?`熊本県内の${label}を${total}店舗掲載。${topAreas.slice(0,3).map(x=>x[0]).join('・')}などのエリア、営業時間、料金目安、特徴を比較して探せます。掲載情報は随時更新しています。`:`熊本県内の${label}情報を掲載するKUMAMOTO BAR NAVIのジャンルページです。`;
  const cards=shops.map(s=>{const name=kbnCleanShopName(s.name)||'BAR',budget=kbnBudget(s),features=String(s.features||'').split(/[、,／/・|]/).map(x=>x.trim()).filter(Boolean).slice(0,3);return `<article class="local-seo-card"><a href="/shop?slug=${encodeURIComponent(s.slug||'')}"><div class="local-seo-img">${s.image_url?`<img src="${kbnSeoEsc(s.image_url)}" alt="${kbnSeoEsc(name)}｜熊本の${kbnSeoEsc(label)}" loading="lazy" decoding="async" fetchpriority="low">`:`<img src="/default-bar.svg" alt="" loading="lazy" decoding="async" fetchpriority="low">`}</div><div class="local-seo-body"><div class="local-seo-meta"><span>${kbnSeoEsc(s.area||'熊本')}</span><span>${kbnSeoEsc(s.genre||label)}</span></div><h2>${kbnSeoEsc(name)}</h2>${s.address?`<p>${kbnSeoEsc(s.address)}</p>`:''}${features.length?`<div class="kbn-area-tags">${features.map(f=>`<span>${kbnSeoEsc(f)}</span>`).join('')}</div>`:''}<div class="local-seo-facts">${s.hours?`<span><small>営業時間</small><b>${kbnSeoEsc(s.hours)}</b></span>`:''}${budget?`<span><small>料金目安</small><b>${kbnSeoEsc(budget)}</b></span>`:''}</div><div class="local-seo-bottom">${Number(s.is_recruiting||0)===1?'<em>求人あり</em>':''}<b>店舗詳細を見る →</b></div></div></a></article>`}).join('');
  const areaLinks=topAreas.map(([a,c])=>{const aslug=kbnAreaSlugForName(a);const href=aslug&&c>=5?`/area/${encodeURIComponent(aslug)}/${encodeURIComponent(slug)}`:`/bars.html?area=${encodeURIComponent(a)}&genre=${encodeURIComponent(label)}`;return `<a href="${href}"><b>${kbnSeoEsc(a)}</b><span>${c}店舗</span></a>`}).join('');
  const faq=[[`熊本の${label}は何店舗掲載されていますか？`,indexable?`現在${total}店舗を掲載しています。公開店舗データに合わせて自動更新されます。`:'掲載情報を順次追加しています。'],[`${label}をエリアから探せますか？`,topAreas.length?`${topAreas.slice(0,4).map(x=>x[0]).join('・')}などのエリアから比較できます。`:'BAR一覧からエリアを指定して探せます。'],[`${label}の営業時間や料金は確認できますか？`,'公開情報が登録されている店舗は、店舗詳細ページで営業時間・料金目安・住所などを確認できます。'],[`${label}の求人も探せますか？`,recruitCount?`現在${recruitCount}店舗で求人情報が登録されています。`:'求人情報が登録された店舗は求人ページに表示されます。']];
  const itemList=shops.slice(0,100).map((s,i)=>({"@type":"ListItem","position":i+1,"name":kbnCleanShopName(s.name),"url":`https://kumamoto-bar-navi.rrwpvwmz8p.workers.dev/shop?slug=${encodeURIComponent(s.slug||'')}`}));
  const genreOrigin="https://kumamoto-bar-navi.rrwpvwmz8p.workers.dev";
  const jsonLd={"@context":"https://schema.org","@graph":[...kbnSchemaSiteNodes(genreOrigin),{"@type":"CollectionPage","@id":canonical,"name":`熊本の${label}`,"url":canonical,"description":description,"inLanguage":"ja-JP","isPartOf":{"@id":`${genreOrigin}/#website`},"publisher":{"@id":`${genreOrigin}/#organization`},"mainEntity":{"@id":`${canonical}#items`}},{"@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"ホーム","item":"https://kumamoto-bar-navi.rrwpvwmz8p.workers.dev/"},{"@type":"ListItem","position":2,"name":"BARを探す","item":"https://kumamoto-bar-navi.rrwpvwmz8p.workers.dev/bars.html"},{"@type":"ListItem","position":3,"name":label,"item":canonical}]},{"@type":"ItemList","@id":`${canonical}#items`,"name":`熊本の${label}一覧`,"numberOfItems":total,"itemListElement":itemList},{"@type":"FAQPage","mainEntity":faq.map(x=>({"@type":"Question","name":x[0],"acceptedAnswer":{"@type":"Answer","text":x[1]}}))}]};
  const robots=indexable?'index,follow,max-image-preview:large':'noindex,follow';
  const facts=[`<div><strong>${total}</strong><span>掲載店舗</span></div>`,hoursCount?`<div><strong>${hoursCount}</strong><span>営業時間掲載</span></div>`:'',topAreas.length?`<div><strong>${topAreas.length}</strong><span>主な掲載エリア</span></div>`:'',avgBudget?`<div><strong>約¥${avgBudget.toLocaleString()}</strong><span>料金目安平均*</span></div>`:''].join('');
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${kbnSeoEsc(title)}</title><meta name="description" content="${kbnSeoEsc(description)}"><link rel="canonical" href="${canonical}"><meta name="robots" content="${robots}"><meta property="og:type" content="website"><meta property="og:title" content="${kbnSeoEsc(title)}"><meta property="og:description" content="${kbnSeoEsc(description)}"><meta property="og:url" content="${canonical}"><meta name="twitter:card" content="summary_large_image"><link rel="stylesheet" href="/style.css?v=210"><script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g,'\u003c')}</script><style>.kbn-area-stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:22px 0}.kbn-area-stats>div{padding:16px;border:1px solid rgba(255,255,255,.12);border-radius:16px;background:rgba(255,255,255,.035)}.kbn-area-stats strong{display:block;font-size:1.45rem}.kbn-area-stats span{font-size:.78rem;opacity:.7}.kbn-area-genres{display:flex;gap:10px;overflow:auto;padding:4px 0 10px}.kbn-area-genres a{min-width:145px;padding:14px;border:1px solid rgba(255,255,255,.12);border-radius:14px;text-decoration:none;color:inherit;background:rgba(255,255,255,.035)}.kbn-area-genres b,.kbn-area-genres span{display:block}.kbn-area-genres span{font-size:.78rem;opacity:.68;margin-top:4px}.kbn-area-tags{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}.kbn-area-tags span{font-size:.72rem;padding:4px 7px;border-radius:999px;background:rgba(255,255,255,.06)}@media(min-width:720px){.kbn-area-stats{grid-template-columns:repeat(4,minmax(0,1fr))}}</style></head><body class="public-v109 local-seo-page"><header class="public-header"><div class="container public-header-inner"><a class="public-brand" href="/"><img src="/logo.png" alt="KUMAMOTO BAR NAVI"><span><b>KUMAMOTO</b><strong>BAR NAVI</strong><small>BAR & JOB INFORMATION</small></span></a><nav class="public-desktop-nav"><a href="/bars.html" class="active">BARを探す</a><a href="/areas.html">エリア</a><a href="/jobs.html">求人</a><a href="/column.html">コラム</a></nav><a class="public-header-cta" href="/bars.html">BARを探す</a></div></header><main><section class="local-seo-hero"><div class="container"><nav class="local-seo-breadcrumb"><a href="/">ホーム</a><span>›</span><a href="/bars.html">BARを探す</a><span>›</span><b>${kbnSeoEsc(label)}</b></nav><p class="public-kicker">KUMAMOTO GENRE GUIDE</p><h1>熊本の${kbnSeoEsc(label)}</h1><p>${indexable?`熊本県内の${kbnSeoEsc(label)}を${total}店舗から比較できます。エリア・営業時間・料金・特徴から今夜行きたい一軒を探してください。`:`${kbnSeoEsc(label)}の掲載情報を順次追加しています。`}</p>${indexable?`<div class="kbn-area-stats">${facts}</div>`:''}${updateDate?`<p class="kbn-area-updated">掲載情報 最終更新：${kbnSeoEsc(updateDate)}</p>`:''}</div></section>${topAreas.length?`<section class="local-seo-guide"><div class="container"><p class="public-kicker">POPULAR AREAS</p><h2>${kbnSeoEsc(label)}をエリアから探す</h2><div class="kbn-area-genres">${areaLinks}</div></div></section>`:''}<section class="local-seo-list"><div class="container"><div class="local-seo-head"><div><p class="public-kicker">BAR LIST</p><h2>熊本の${kbnSeoEsc(label)}一覧</h2></div><a href="/bars.html?genre=${encodeURIComponent(label)}">条件を指定して探す →</a></div>${shops.length?`<div class="local-seo-grid">${cards}</div>${total>shops.length?`<p class="kbn-area-note">このページでは代表的な${shops.length}店舗を表示しています。</p>`:''}`:`<div class="local-seo-empty"><h2>掲載店舗を準備中です</h2></div>`}</div></section><section class="local-seo-guide"><div class="container"><p class="public-kicker">GENRE GUIDE</p><h2>熊本で${kbnSeoEsc(label)}を探すポイント</h2><p>掲載店舗のエリア、営業時間、料金目安、特徴を比較できます。店舗情報は随時更新していますが、営業時間や料金など重要な情報は来店前に各店舗へ直接確認してください。</p></div></section><section class="local-seo-faq"><div class="container"><p class="public-kicker">FAQ</p><h2>${kbnSeoEsc(label)}探し よくある質問</h2><div>${faq.map(x=>`<details><summary>${kbnSeoEsc(x[0])}</summary><p>${kbnSeoEsc(x[1])}</p></details>`).join('')}</div></div></section></main><nav class="public-bottom-nav"><a href="/"><span>⌂</span><b>ホーム</b></a><a href="/bars.html"><span>⌕</span><b>BARを探す</b></a><a href="/jobs.html"><span>▣</span><b>求人</b></a><a href="/listing-form.html"><span>＋</span><b>店舗掲載</b></a></nav></body></html>`;
}


function kbnAreaSlugForName(areaName){
  const needle=String(areaName||"").trim();
  for(const [slug,name] of Object.entries(KBN_LOCAL_SEO_AREAS||{})){
    if(String(name||"").trim()===needle)return slug;
  }
  return "";
}
function kbnGenreSlugForText(value){
  const text=String(value||"").trim().toLowerCase();
  if(!text)return "";
  for(const [slug,cfg] of Object.entries(KBN_LOCAL_SEO_GENRES||{})){
    const label=String(cfg?.label||"").toLowerCase();
    if(label===text || label.includes(text) || text.includes(label))return slug;
    if((cfg?.terms||[]).some(term=>text.includes(String(term).toLowerCase())))return slug;
  }
  return "";
}
function kbnGenreSqlParts(cfg){
  const terms=(cfg?.terms||[]).filter(Boolean);
  return {
    terms,
    condition:terms.map(()=>`LOWER(COALESCE(genre,'') || ' ' || COALESCE(features,'') || ' ' || COALESCE(description,'') || ' ' || COALESCE(hours,'')) LIKE ?`).join(' OR '),
    binds:terms.map(x=>`%${String(x).toLowerCase()}%`)
  };
}
function kbnShopMatchesGenreTerms(shop,cfg){
  const text=[shop?.genre,shop?.features,shop?.description,shop?.hours].filter(Boolean).join(" ").toLowerCase();
  return (cfg?.terms||[]).some(term=>text.includes(String(term).toLowerCase()));
}

// Long-tail SEO landing page: /area/{area-slug}/{genre-slug}
// Only combinations with 5+ matching public shops are indexable. This deliberately avoids
// generating thin location x intent pages while still creating useful search landing pages.
async function renderLocalSeoAreaGenrePage(env,areaSlug,genreSlug){
  const area=KBN_LOCAL_SEO_AREAS?.[areaSlug];
  const cfg=KBN_LOCAL_SEO_GENRES?.[genreSlug];
  if(!area||!cfg)return null;
  const {terms,condition,binds}=kbnGenreSqlParts(cfg);
  if(!terms.length||!condition)return null;

  let shops=[],total=0,updatedAt="",sameGenreAreas=[],areaInventory=[];
  try{
    const [lr,cr,ar,inventory]=await Promise.all([
      env.DB.prepare(`
        SELECT slug,name,area,address,hours,holiday,genre,features,budget_min,budget_max,image_url,
               listing_status,is_recruiting,description,updated_at
        FROM shops
        WHERE COALESCE(is_published,1)=1 AND COALESCE(slug,'')<>'' AND area=? AND (${condition})
        ORDER BY COALESCE(is_featured,0) DESC, COALESCE(sort_order,100) ASC, updated_at DESC
        LIMIT 120
      `).bind(area,...binds).all(),
      env.DB.prepare(`
        SELECT COUNT(*) AS total, MAX(updated_at) AS updated_at
        FROM shops
        WHERE COALESCE(is_published,1)=1 AND COALESCE(slug,'')<>'' AND area=? AND (${condition})
      `).bind(area,...binds).first(),
      env.DB.prepare(`
        SELECT area,COUNT(*) AS total
        FROM shops
        WHERE COALESCE(is_published,1)=1 AND COALESCE(slug,'')<>'' AND COALESCE(area,'')<>'' AND (${condition})
        GROUP BY area ORDER BY total DESC, area ASC LIMIT 12
      `).bind(...binds).all(),
      env.DB.prepare(`
        SELECT genre,features,description,hours
        FROM shops
        WHERE COALESCE(is_published,1)=1 AND COALESCE(slug,'')<>'' AND area=?
        ORDER BY updated_at DESC LIMIT 600
      `).bind(area).all()
    ]);
    shops=lr.results||[];
    total=Number(cr?.total||shops.length||0);
    updatedAt=String(cr?.updated_at||shops[0]?.updated_at||"");
    sameGenreAreas=ar.results||[];
    areaInventory=inventory.results||[];
  }catch(e){
    console.error("local seo area genre query",areaSlug,genreSlug,e);
  }

  const label=cfg.label;
  const canonical=`https://kumamoto-bar-navi.rrwpvwmz8p.workers.dev/area/${encodeURIComponent(areaSlug)}/${encodeURIComponent(genreSlug)}`;
  const indexable=total>=5;
  const updateDate=updatedAt?String(updatedAt).slice(0,10).replace(/-/g,"/"):"";

  let hoursCount=0,recruitCount=0,budgetCount=0,budgetSum=0,addressCount=0;
  for(const shop of shops){
    if(String(shop.hours||"").trim())hoursCount++;
    if(String(shop.address||"").trim())addressCount++;
    if(Number(shop.is_recruiting||0)===1)recruitCount++;
    const lo=Number(shop.budget_min||0),hi=Number(shop.budget_max||0);
    const mid=lo&&hi?(lo+hi)/2:(lo||hi||0);
    if(mid>0){budgetCount++;budgetSum+=mid;}
  }
  const avgBudget=budgetCount?Math.round((budgetSum/budgetCount)/100)*100:0;

  const relatedGenres=[];
  for(const [slug,otherCfg] of Object.entries(KBN_LOCAL_SEO_GENRES||{})){
    if(slug===genreSlug)continue;
    let count=0;
    for(const row of areaInventory)if(kbnShopMatchesGenreTerms(row,otherCfg))count++;
    if(count>=5)relatedGenres.push({slug,label:otherCfg.label,count});
  }
  relatedGenres.sort((a,b)=>b.count-a.count||a.label.localeCompare(b.label,"ja"));

  const otherAreas=sameGenreAreas
    .map(row=>({area:String(row.area||"").trim(),count:Number(row.total||0)}))
    .map(x=>({...x,slug:kbnAreaSlugForName(x.area)}))
    .filter(x=>x.slug&&x.slug!==areaSlug&&x.count>=5)
    .slice(0,8);

  const title=`${area}の${label}${total?` ${total}店舗`:""}｜営業時間・料金・特徴から探す｜KUMAMOTO BAR NAVI`;
  const description=indexable
    ? `${area}の${label}を${total}店舗掲載。営業時間、料金目安、住所、特徴を比較して今夜行きたい一軒を探せます。${hoursCount?`${hoursCount}店舗で営業時間を確認可能。`:""}掲載情報は随時更新しています。`
    : `${area}の${label}情報を掲載するKUMAMOTO BAR NAVIの検索ページです。掲載情報を順次充実させています。`;

  const cards=shops.map(s=>{
    const name=kbnCleanShopName(s.name)||"BAR";
    const budget=kbnBudget(s);
    const features=String(s.features||"").split(/[、,／/・|]/).map(x=>x.trim()).filter(Boolean).slice(0,3);
    return `<article class="local-seo-card"><a href="/shop?slug=${encodeURIComponent(s.slug||"")}"><div class="local-seo-img">${s.image_url?`<img src="${kbnSeoEsc(s.image_url)}" alt="${kbnSeoEsc(name)}｜${kbnSeoEsc(area)}の${kbnSeoEsc(label)}" loading="lazy" decoding="async" fetchpriority="low">`:`<img src="/default-bar.svg" alt="" loading="lazy" decoding="async" fetchpriority="low">`}</div><div class="local-seo-body"><div class="local-seo-meta"><span>${kbnSeoEsc(area)}</span><span>${kbnSeoEsc(s.genre||label)}</span></div><h2>${kbnSeoEsc(name)}</h2>${s.address?`<p>${kbnSeoEsc(s.address)}</p>`:""}${features.length?`<div class="kbn-area-tags">${features.map(f=>`<span>${kbnSeoEsc(f)}</span>`).join("")}</div>`:""}<div class="local-seo-facts">${s.hours?`<span><small>営業時間</small><b>${kbnSeoEsc(s.hours)}</b></span>`:""}${budget?`<span><small>料金目安</small><b>${kbnSeoEsc(budget)}</b></span>`:""}</div><div class="local-seo-bottom">${Number(s.is_recruiting||0)===1?"<em>求人あり</em>":""}<b>店舗詳細を見る →</b></div></div></a></article>`;
  }).join("");

  const facts=[
    `<div><strong>${total}</strong><span>掲載店舗</span></div>`,
    hoursCount?`<div><strong>${hoursCount}</strong><span>営業時間掲載</span></div>`:"",
    addressCount?`<div><strong>${addressCount}</strong><span>住所掲載</span></div>`:"",
    avgBudget?`<div><strong>約¥${avgBudget.toLocaleString()}</strong><span>料金目安平均*</span></div>`:""
  ].join("");

  const otherAreaLinks=otherAreas.map(x=>`<a href="/area/${encodeURIComponent(x.slug)}/${encodeURIComponent(genreSlug)}"><b>${kbnSeoEsc(x.area)}</b><span>${x.count}店舗</span></a>`).join("");
  const relatedGenreLinks=relatedGenres.slice(0,8).map(x=>`<a href="/area/${encodeURIComponent(areaSlug)}/${encodeURIComponent(x.slug)}"><b>${kbnSeoEsc(x.label)}</b><span>${x.count}店舗</span></a>`).join("");

  const faq=[
    [`${area}の${label}は何店舗掲載されていますか？`,indexable?`現在${total}店舗を掲載しています。公開店舗データに合わせて自動更新されます。`:`掲載情報を順次追加しています。`],
    [`${area}の${label}の営業時間は確認できますか？`,hoursCount?`${hoursCount}店舗で営業時間を確認できます。最新の営業状況は来店前に店舗へ直接確認してください。`:`営業時間が登録された店舗は詳細ページに表示されます。`],
    [`${area}の${label}の料金目安は比較できますか？`,avgBudget?`料金情報が登録されている店舗の目安平均は約¥${avgBudget.toLocaleString()}です。店舗ごとの料金は詳細ページで確認できます。`:`料金情報が登録されている店舗は詳細ページで確認できます。`],
    [`${area}でほかのジャンルも探せますか？`,relatedGenres.length?`${relatedGenres.slice(0,4).map(x=>x.label).join("・")}など、掲載数が十分ある条件から探せます。`:`${area}のエリアページから掲載店舗を比較できます。`]
  ];

  const itemList=shops.slice(0,100).map((shop,i)=>({"@type":"ListItem","position":i+1,"name":kbnCleanShopName(shop.name),"url":`https://kumamoto-bar-navi.rrwpvwmz8p.workers.dev/shop?slug=${encodeURIComponent(shop.slug||"")}`}));
  const areaGenreOrigin="https://kumamoto-bar-navi.rrwpvwmz8p.workers.dev";
  const jsonLd={"@context":"https://schema.org","@graph":[
    ...kbnSchemaSiteNodes(areaGenreOrigin),
    {"@type":"CollectionPage","@id":canonical,"name":`${area}の${label}`,"url":canonical,"description":description,"inLanguage":"ja-JP","isPartOf":{"@id":`${areaGenreOrigin}/#website`},"publisher":{"@id":`${areaGenreOrigin}/#organization`},"mainEntity":{"@id":`${canonical}#items`}},
    {"@type":"BreadcrumbList","itemListElement":[
      {"@type":"ListItem","position":1,"name":"ホーム","item":"https://kumamoto-bar-navi.rrwpvwmz8p.workers.dev/"},
      {"@type":"ListItem","position":2,"name":area,"item":`https://kumamoto-bar-navi.rrwpvwmz8p.workers.dev/area/${encodeURIComponent(areaSlug)}`},
      {"@type":"ListItem","position":3,"name":label,"item":canonical}
    ]},
    {"@type":"ItemList","@id":`${canonical}#items`,"name":`${area}の${label}一覧`,"numberOfItems":total,"itemListElement":itemList},
    {"@type":"FAQPage","mainEntity":faq.map(x=>({"@type":"Question","name":x[0],"acceptedAnswer":{"@type":"Answer","text":x[1]}}))}
  ]};

  const robots=indexable?"index,follow,max-image-preview:large":"noindex,follow";
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${kbnSeoEsc(title)}</title><meta name="description" content="${kbnSeoEsc(description)}"><link rel="canonical" href="${canonical}"><meta name="robots" content="${robots}"><meta property="og:type" content="website"><meta property="og:title" content="${kbnSeoEsc(title)}"><meta property="og:description" content="${kbnSeoEsc(description)}"><meta property="og:url" content="${canonical}"><meta name="twitter:card" content="summary_large_image"><link rel="stylesheet" href="/style.css?v=210"><script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g,"\\u003c")}</script><style>.kbn-area-stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:22px 0}.kbn-area-stats>div{padding:16px;border:1px solid rgba(255,255,255,.12);border-radius:16px;background:rgba(255,255,255,.035)}.kbn-area-stats strong{display:block;font-size:1.45rem}.kbn-area-stats span{font-size:.78rem;opacity:.7}.kbn-area-genres{display:flex;gap:10px;overflow:auto;padding:4px 0 10px}.kbn-area-genres a{min-width:145px;padding:14px;border:1px solid rgba(255,255,255,.12);border-radius:14px;text-decoration:none;color:inherit;background:rgba(255,255,255,.035)}.kbn-area-genres b,.kbn-area-genres span{display:block}.kbn-area-genres span{font-size:.78rem;opacity:.68;margin-top:4px}.kbn-area-tags{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}.kbn-area-tags span{font-size:.72rem;padding:4px 7px;border-radius:999px;background:rgba(255,255,255,.06)}.kbn-area-note,.kbn-area-updated{font-size:.76rem;opacity:.64}@media(min-width:720px){.kbn-area-stats{grid-template-columns:repeat(4,minmax(0,1fr))}}</style></head><body class="public-v109 local-seo-page"><header class="public-header"><div class="container public-header-inner"><a class="public-brand" href="/"><img src="/logo.png" alt="KUMAMOTO BAR NAVI"><span><b>KUMAMOTO</b><strong>BAR NAVI</strong><small>BAR & JOB INFORMATION</small></span></a><nav class="public-desktop-nav"><a href="/bars.html" class="active">BARを探す</a><a href="/areas.html">エリア</a><a href="/jobs.html">求人</a><a href="/column.html">コラム</a></nav><a class="public-header-cta" href="/bars.html">BARを探す</a></div></header><main><section class="local-seo-hero"><div class="container"><nav class="local-seo-breadcrumb"><a href="/">ホーム</a><span>›</span><a href="/area/${encodeURIComponent(areaSlug)}">${kbnSeoEsc(area)}</a><span>›</span><b>${kbnSeoEsc(label)}</b></nav><p class="public-kicker">AREA × GENRE GUIDE</p><h1>${kbnSeoEsc(area)}の${kbnSeoEsc(label)}</h1><p>${indexable?`${kbnSeoEsc(area)}で探せる${kbnSeoEsc(label)}を${total}店舗から比較できます。営業時間・料金・住所・特徴から今夜行きたい一軒を探してください。`:`${kbnSeoEsc(area)}の${kbnSeoEsc(label)}情報を順次追加しています。`}</p>${indexable?`<div class="kbn-area-stats">${facts}</div>`:""}${updateDate?`<p class="kbn-area-updated">掲載情報 最終更新：${kbnSeoEsc(updateDate)}</p>`:""}</div></section>${otherAreas.length?`<section class="local-seo-guide"><div class="container"><p class="public-kicker">OTHER AREAS</p><h2>${kbnSeoEsc(label)}をほかのエリアから探す</h2><div class="kbn-area-genres">${otherAreaLinks}</div></div></section>`:""}<section class="local-seo-list"><div class="container"><div class="local-seo-head"><div><p class="public-kicker">BAR LIST</p><h2>${kbnSeoEsc(area)}の${kbnSeoEsc(label)}一覧</h2></div><a href="/bars.html?area=${encodeURIComponent(area)}&genre=${encodeURIComponent(label)}">条件を指定して探す →</a></div>${shops.length?`<div class="local-seo-grid">${cards}</div>${total>shops.length?`<p class="kbn-area-note">このページでは代表的な${shops.length}店舗を表示しています。</p>`:""}`:`<div class="local-seo-empty"><h2>掲載店舗を準備中です</h2></div>`}</div></section>${relatedGenres.length?`<section class="local-seo-guide"><div class="container"><p class="public-kicker">RELATED GENRES</p><h2>${kbnSeoEsc(area)}のほかのジャンル</h2><div class="kbn-area-genres">${relatedGenreLinks}</div></div></section>`:""}<section class="local-seo-guide"><div class="container"><p class="public-kicker">LOCAL GUIDE</p><h2>${kbnSeoEsc(area)}で${kbnSeoEsc(label)}を探すポイント</h2><p>${kbnSeoEsc(`${area}の${label}を、営業時間・料金目安・住所・店舗の特徴から比較できます。掲載内容は公開店舗データに合わせて更新しています。営業時間や料金など重要な情報は来店前に各店舗へ直接確認してください。`)}</p></div></section><section class="local-seo-faq"><div class="container"><p class="public-kicker">FAQ</p><h2>${kbnSeoEsc(area)}の${kbnSeoEsc(label)} よくある質問</h2><div>${faq.map(x=>`<details><summary>${kbnSeoEsc(x[0])}</summary><p>${kbnSeoEsc(x[1])}</p></details>`).join("")}</div></div></section></main><nav class="public-bottom-nav"><a href="/"><span>⌂</span><b>ホーム</b></a><a href="/bars.html"><span>⌕</span><b>BARを探す</b></a><a href="/jobs.html"><span>▣</span><b>求人</b></a><a href="/listing-form.html"><span>＋</span><b>店舗掲載</b></a></nav></body></html>`;
}


async function renderSeoShopDetailV250(request,env,url){
  const slug=String(url.searchParams.get("slug")||"").trim();
  if(!slug)return null;

  let shop=null;
  try{
    shop=await env.DB.prepare(`
      SELECT * FROM shops
      WHERE slug=? AND COALESCE(is_published,1)=1
      LIMIT 1
    `).bind(slug).first();
  }catch(e){
    console.error("seo shop query",e);
    return null;
  }

  if(!shop){
    return new Response(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,follow"><title>店舗が見つかりません｜KUMAMOTO BAR NAVI</title><link rel="canonical" href="${url.origin}/bars.html"></head><body><main><h1>店舗が見つかりません</h1><p>指定された店舗は現在公開されていません。</p><p><a href="/bars.html">熊本のBARを探す</a></p></main></body></html>`,{
      status:404,
      headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-cache, max-age=0, must-revalidate","x-robots-tag":"noindex, follow"}
    });
  }

  const assetUrl=new URL("/shop.html",url.origin);
  const asset=await env.ASSETS.fetch(new Request(assetUrl.toString(),{method:"GET",headers:request.headers}));
  if(!asset.ok)return asset;
  let html=await asset.text();

  const name=kbnCleanShopName(shop.name)||"BAR";
  const area=String(shop.area||"熊本").trim()||"熊本";
  const genre=String(shop.genre||"BAR").trim()||"BAR";
  const canonical=`${url.origin}/shop?slug=${encodeURIComponent(shop.slug)}`;
  const budget=kbnBudget(shop);
  const rawDesc=String(shop.description||"").replace(/※本ページ[\s\S]*/g,"").replace(/\s+/g," ").trim();
  const featureList=String(shop.features||"")
    .split(/[、,\/｜|・\n]+/).map(x=>x.trim()).filter(Boolean).slice(0,8);
  const description=[
    `${area}の${genre}「${name}」の店舗情報`,
    rawDesc?rawDesc.slice(0,82):"",
    shop.address?`住所 ${String(shop.address).trim()}`:"",
    shop.hours?`営業時間 ${String(shop.hours).trim()}`:"",
    budget?`料金目安 ${budget}`:""
  ].filter(Boolean).join("。").slice(0,158);
  const title=`${name}｜${area}の${genre}・営業時間・料金｜KUMAMOTO BAR NAVI`;

  const areaSlug=kbnAreaSlugForName(area);
  const genreSlug=kbnGenreSlugForText(genre);
  const genreCfg=genreSlug?KBN_LOCAL_SEO_GENRES?.[genreSlug]:null;
  let relatedArea=[],relatedGenre=[],areaGenreCount=0,genreCount=0;
  try{
    const tasks=[
      env.DB.prepare(`
        SELECT slug,name,area,genre,address,hours
        FROM shops
        WHERE COALESCE(is_published,1)=1 AND area=? AND slug<>?
        ORDER BY CASE WHEN genre=? THEN 0 ELSE 1 END, COALESCE(updated_at,created_at) DESC, id DESC
        LIMIT 6
      `).bind(area,shop.slug,genre).all()
    ];
    if(genreCfg){
      const gp=kbnGenreSqlParts(genreCfg);
      tasks.push(
        env.DB.prepare(`
          SELECT slug,name,area,genre,address,hours
          FROM shops
          WHERE COALESCE(is_published,1)=1 AND slug<>? AND (${gp.condition})
          ORDER BY CASE WHEN area=? THEN 0 ELSE 1 END, COALESCE(updated_at,created_at) DESC, id DESC
          LIMIT 8
        `).bind(shop.slug,...gp.binds,area).all(),
        env.DB.prepare(`
          SELECT COUNT(*) AS total
          FROM shops
          WHERE COALESCE(is_published,1)=1 AND (${gp.condition})
        `).bind(...gp.binds).first()
      );
      if(areaSlug){
        tasks.push(env.DB.prepare(`
          SELECT COUNT(*) AS total
          FROM shops
          WHERE COALESCE(is_published,1)=1 AND area=? AND (${gp.condition})
        `).bind(area,...gp.binds).first());
      }
    }
    const results=await Promise.all(tasks);
    relatedArea=results[0]?.results||[];
    if(genreCfg){
      relatedGenre=(results[1]?.results||[]).filter(r=>String(r.area||'').trim()!==area).slice(0,6);
      genreCount=Number(results[2]?.total||0);
      if(areaSlug)areaGenreCount=Number(results[3]?.total||0);
    }
  }catch(e){
    console.error("seo related shops query",e);
  }

  const origin=url.origin;
  const siteNodes=kbnSchemaSiteNodes(origin);
  const businessNode=kbnSchemaShopNode(shop,{origin,canonical,name,area,genre,description,budget,featureList});
  const published=String(shop.published_at||shop.created_at||"").trim();
  const modified=String(shop.updated_at||shop.published_at||shop.created_at||"").trim();
  const jsonLd={
    "@context":"https://schema.org",
    "@graph":[
      ...siteNodes,
      businessNode,
      {
        "@type":"WebPage",
        "@id":canonical,
        "url":canonical,
        "name":title,
        "description":description,
        "inLanguage":"ja-JP",
        "isPartOf":{"@id":`${origin}/#website`},
        "publisher":{"@id":`${origin}/#organization`},
        "about":{"@id":`${canonical}#business`},
        "mainEntity":{"@id":`${canonical}#business`},
        ...(kbnSeoImageData(shop,{origin,canonical,name,area,genre})?{"primaryImageOfPage":{"@id":`${canonical}#primaryimage`}}:{}),
        ...(published?{"datePublished":published}:{}),
        ...(modified?{"dateModified":modified}:{})
      },
      {
        "@type":"BreadcrumbList",
        "@id":`${canonical}#breadcrumb`,
        "itemListElement":[
          {"@type":"ListItem","position":1,"name":"ホーム","item":`${origin}/`},
          {"@type":"ListItem","position":2,"name":"BARを探す","item":`${origin}/bars.html`},
          ...(areaSlug?[{"@type":"ListItem","position":3,"name":area,"item":`${origin}/area/${encodeURIComponent(areaSlug)}`}]:[]),
          {"@type":"ListItem","position":areaSlug?4:3,"name":name,"item":canonical}
        ]
      }
    ]
  };

  const escAttr=v=>kbnSeoEsc(v);
  const primaryImage=kbnSeoImageData(shop,{origin:url.origin,canonical,name,area,genre});
  const ogImage=primaryImage?.url||`${url.origin}/logo.png`;
  const ogImageAlt=primaryImage?.alt||`KUMAMOTO BAR NAVI｜${name}`;

  // Real shop pages are indexable from the first byte Google receives.
  // Remove stale robots/googlebot directives from the shared template, then add one authoritative directive.
  html=html
    .replace(/<meta\b[^>]*\bname\s*=\s*["'](?:robots|googlebot)["'][^>]*>/gi,"")
    .replace(/<head([^>]*)>/i,'<head$1><meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1">')
    .replace(/<title>[\s\S]*?<\/title>/i,`<title>${escAttr(title)}</title>`)
    .replace(/<meta name="description" content="[^"]*">/i,`<meta name="description" content="${escAttr(description)}">`)
    .replace(/<link id="dynamicCanonical" rel="canonical" href="[^"]*">/i,`<link id="dynamicCanonical" rel="canonical" href="${escAttr(canonical)}">`)
    .replace(/<meta id="dynamicOgTitle" property="og:title" content="[^"]*">/i,`<meta id="dynamicOgTitle" property="og:title" content="${escAttr(title)}">`)
    .replace(/<meta id="dynamicOgDescription" property="og:description" content="[^"]*">/i,`<meta id="dynamicOgDescription" property="og:description" content="${escAttr(description)}">`)
    .replace(/<meta id="dynamicOgUrl" property="og:url" content="[^"]*">/i,`<meta id="dynamicOgUrl" property="og:url" content="${escAttr(canonical)}">`)
    .replace(/<script id="shopJsonLd" type="application\/ld\+json">[\s\S]*?<\/script>/i,`<script id="shopJsonLd" type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g,"\\u003c")}</script>`);

  const socialMeta=`\n<meta property="og:site_name" content="KUMAMOTO BAR NAVI">\n<meta property="og:locale" content="ja_JP">\n<meta property="og:image" content="${escAttr(ogImage)}">\n<meta property="og:image:secure_url" content="${escAttr(ogImage)}">\n<meta property="og:image:alt" content="${escAttr(ogImageAlt)}">\n<meta name="twitter:card" content="summary_large_image">\n<meta name="twitter:title" content="${escAttr(title)}">\n<meta name="twitter:description" content="${escAttr(description)}">\n<meta name="twitter:image" content="${escAttr(ogImage)}">\n<meta name="twitter:image:alt" content="${escAttr(ogImageAlt)}">`;
  const internalLinkCss=`<style>.kbn-seo-primary-image{margin:16px 0 22px;border-radius:18px;overflow:hidden;background:#0d141b}.kbn-seo-primary-image img{display:block;width:100%;height:auto;max-height:640px;object-fit:cover}.kbn-seo-primary-image figcaption{padding:8px 11px;font-size:.7rem;opacity:.66}.kbn-seo-link-hub{margin:28px 0}.kbn-seo-link-hub h2{margin:0 0 12px}.kbn-seo-link-hub>div{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.kbn-seo-link-hub a{display:block;padding:14px;border:1px solid rgba(255,255,255,.13);border-radius:14px;text-decoration:none;color:inherit;background:rgba(255,255,255,.035)}.kbn-seo-link-hub strong,.kbn-seo-link-hub span{display:block}.kbn-seo-link-hub span{margin-top:4px;font-size:.76rem;opacity:.68}.kbn-seo-related{margin:28px 0}.kbn-seo-related ul{list-style:none;padding:0;margin:12px 0}.kbn-seo-related li+li{margin-top:8px}.kbn-seo-related li a{display:flex;justify-content:space-between;gap:12px;padding:12px;border:1px solid rgba(255,255,255,.10);border-radius:12px;text-decoration:none;color:inherit}.kbn-seo-related li span{font-size:.76rem;opacity:.66;text-align:right}@media(max-width:560px){.kbn-seo-link-hub>div{grid-template-columns:1fr}}</style>`;
  html=html.replace('</head>',`${socialMeta}\n${internalLinkCss}\n</head>`);

  const updated=String(shop.updated_at||shop.published_at||shop.created_at||"").trim();
  const updatedLabel=updated?updated.slice(0,10).replace(/-/g,"/"):"";
  const facts=[
    shop.address?["住所",shop.address]:null,
    shop.hours?["営業時間",shop.hours]:null,
    shop.holiday?["定休日",shop.holiday]:null,
    budget?["料金目安",budget]:null,
    shop.seats?["席数",`${shop.seats}席`]:null,
    shop.phone?["電話",shop.phone]:null
  ].filter(Boolean);
  const areaHref=areaSlug?`/area/${encodeURIComponent(areaSlug)}`:`/bars.html?area=${encodeURIComponent(area)}`;
  const genreHref=genreSlug&&genreCount>=3?`/genre/${encodeURIComponent(genreSlug)}`:`/bars.html?genre=${encodeURIComponent(genre)}`;
  const areaGenreHref=areaSlug&&genreSlug&&areaGenreCount>=5?`/area/${encodeURIComponent(areaSlug)}/${encodeURIComponent(genreSlug)}`:`/bars.html?area=${encodeURIComponent(area)}&genre=${encodeURIComponent(genre)}`;
  const seoNav=`<section class="kbn-seo-link-hub" aria-label="関連するBAR検索"><h2>条件を変えてBARを探す</h2><div><a href="${areaHref}"><strong>${kbnSeoEsc(area)}のBAR</strong><span>同じエリアから探す</span></a><a href="${genreHref}"><strong>${kbnSeoEsc(genre)}</strong><span>熊本県内の同ジャンル</span></a>${areaGenreCount>=5?`<a href="${areaGenreHref}"><strong>${kbnSeoEsc(area)} × ${kbnSeoEsc(genre)}</strong><span>${areaGenreCount}店舗を比較</span></a>`:""}<a href="/all-shops"><strong>掲載BAR全店舗</strong><span>全エリアから探す</span></a></div></section>`;
  const relatedAreaHtml=relatedArea.length?`<section class="kbn-seo-related"><h2>${kbnSeoEsc(area)}の近くのBAR</h2><ul>${relatedArea.map(r=>`<li><a href="/shop?slug=${encodeURIComponent(r.slug||"")}"><strong>${kbnSeoEsc(kbnCleanShopName(r.name)||"BAR")}</strong><span>${kbnSeoEsc([r.area,r.genre].filter(Boolean).join(" / "))}</span></a></li>`).join("")}</ul><p><a href="${areaHref}">${kbnSeoEsc(area)}のBARを一覧で見る →</a></p></section>`:"";
  const relatedGenreHtml=relatedGenre.length?`<section class="kbn-seo-related"><h2>熊本の${kbnSeoEsc(genre)}をもっと見る</h2><ul>${relatedGenre.map(r=>`<li><a href="/shop?slug=${encodeURIComponent(r.slug||"")}"><strong>${kbnSeoEsc(kbnCleanShopName(r.name)||"BAR")}</strong><span>${kbnSeoEsc([r.area,r.genre].filter(Boolean).join(" / "))}</span></a></li>`).join("")}</ul><p><a href="${genreHref}">熊本の${kbnSeoEsc(genre)}を一覧で見る →</a></p></section>`:"";
  const fallback=`<article class="public-shop-layout kbn-seo-server-shop" data-seo-fallback="1">
    <section class="public-shop-summary">
      <nav aria-label="パンくず"><a href="/">ホーム</a> › <a href="/bars.html">BARを探す</a>${areaSlug?` › <a href="${areaHref}">${kbnSeoEsc(area)}</a>`:""} › <span>${kbnSeoEsc(name)}</span></nav>
      <p class="public-shop-location">${kbnSeoEsc([area,genre].filter(Boolean).join(" / "))}</p>
      <h1>${kbnSeoEsc(name)}</h1>
      ${primaryImage?`<figure class="kbn-seo-primary-image"><img src="${escAttr(primaryImage.url)}" alt="${escAttr(primaryImage.alt)}" loading="eager" decoding="async" fetchpriority="high" referrerpolicy="no-referrer-when-downgrade"><figcaption>${escAttr(primaryImage.alt)}</figcaption></figure>`:""}
      ${rawDesc?`<p class="kbn-seo-description">${kbnSeoEsc(rawDesc)}</p>`:`<p class="kbn-seo-description">${kbnSeoEsc(`${name}は${area}で掲載中の${genre}です。住所・営業時間・料金目安など、来店前に確認したい店舗情報をまとめています。`)}</p>`}
      ${featureList.length?`<div class="kbn-seo-features" aria-label="店舗の特徴">${featureList.map(x=>`<span>${kbnSeoEsc(x)}</span>`).join("")}</div>`:""}
      ${facts.length?`<section><h2>${kbnSeoEsc(name)}の基本情報</h2><dl>${facts.map(([k,v])=>`<div><dt>${kbnSeoEsc(k)}</dt><dd>${kbnSeoEsc(v)}</dd></div>`).join("")}</dl></section>`:""}
      ${(sameAs.length||shop.phone)?`<section><h2>公式・連絡先</h2><p>${shop.phone?`<a href="tel:${kbnSeoEsc(String(shop.phone).replace(/[^0-9+]/g,""))}">電話で確認する</a> `:""}${sameAs.length?`<a href="${kbnSeoEsc(sameAs[0])}" rel="nofollow noopener">Instagramを確認する</a>`:""}</p></section>`:""}
      ${updatedLabel?`<p class="kbn-seo-updated"><small>店舗情報 最終更新：${kbnSeoEsc(updatedLabel)}</small></p>`:""}
      ${seoNav}
      ${relatedAreaHtml}
      ${relatedGenreHtml}
    </section>
  </article>`;
  html=html.replace('<div id="shopDetail"><div class="public-loading">店舗情報を読み込んでいます...</div></div>',`<div id="shopDetail">${fallback}</div>`);

  html=kbnInjectCwvHints(html,primaryImage?.url||"");

  const h=new Headers(asset.headers);
  h.delete("content-length");
  h.set("content-type","text/html; charset=utf-8");
  h.set("content-language","ja");
  h.set("cache-control","public, max-age=300, stale-while-revalidate=600");
  h.set("x-robots-tag","index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1");
  h.set("link",`<${canonical}>; rel="canonical"`);
  return new Response(html,{status:200,headers:h});
}

async function renderAllShopsSeoIndexV250(env,origin){
  let shops=[];
  try{
    const r=await env.DB.prepare(`
      SELECT slug,name,area,genre,updated_at
      FROM shops
      WHERE COALESCE(is_published,1)=1 AND TRIM(COALESCE(slug,''))<>''
      ORDER BY area ASC,name ASC
      LIMIT 5000
    `).all();
    shops=r.results||[];
  }catch(e){console.error("all shops seo index",e)}
  const canonical=`${origin}/all-shops`;
  const groups=new Map();
  for(const x of shops){
    const area=String(x.area||"その他").trim()||"その他";
    if(!groups.has(area))groups.set(area,[]);
    groups.get(area).push(x);
  }
  const areaSlugByName=new Map(Object.entries(KBN_LOCAL_SEO_AREAS||{}).map(([slug,name])=>[String(name),slug]));
  const sections=[...groups.entries()].map(([area,list])=>{
    const areaSlug=areaSlugByName.get(area);
    const areaLink=areaSlug?` <a href="/area/${encodeURIComponent(areaSlug)}" style="font-size:.8em">${kbnSeoEsc(area)}のエリアページ →</a>`:"";
    return `<section><h2>${kbnSeoEsc(area)}${areaLink}</h2><ul>${list.map(x=>`<li><a href="/shop?slug=${encodeURIComponent(x.slug||"")}">${kbnSeoEsc(kbnCleanShopName(x.name)||"BAR")}</a>${x.genre?` <small>${kbnSeoEsc(x.genre)}</small>`:""}</li>`).join("")}</ul></section>`;
  }).join("");
  const title=`熊本県の掲載BAR全店舗一覧（${shops.length}店舗）｜KUMAMOTO BAR NAVI`;
  const desc=`KUMAMOTO BAR NAVIに掲載中の熊本県内BAR全店舗一覧。現在${shops.length}店舗をエリア別に掲載しています。`;
  const itemList={"@context":"https://schema.org","@graph":[...kbnSchemaSiteNodes(origin),{"@type":"CollectionPage","@id":canonical,"url":canonical,"name":"熊本県の掲載BAR全店舗一覧","description":desc,"inLanguage":"ja-JP","isPartOf":{"@id":`${origin}/#website`},"publisher":{"@id":`${origin}/#organization`},"mainEntity":{"@id":`${canonical}#items`}},{"@type":"ItemList","@id":`${canonical}#items`,"name":"熊本県の掲載BAR全店舗一覧","numberOfItems":shops.length,"itemListElement":shops.slice(0,5000).map((x,i)=>({"@type":"ListItem","position":i+1,"name":kbnCleanShopName(x.name)||"BAR","url":`${origin}/shop?slug=${encodeURIComponent(x.slug||"")}`}))}]};
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${kbnSeoEsc(title)}</title><meta name="description" content="${kbnSeoEsc(desc)}"><meta name="robots" content="index,follow,max-image-preview:large"><link rel="canonical" href="${canonical}"><script type="application/ld+json">${JSON.stringify(itemList).replace(/</g,"\u003c")}</script><link rel="stylesheet" href="/style.css?v=196"></head><body class="public-v109"><header class="public-header"><div class="container public-header-inner"><a class="public-brand" href="/"><img src="/logo.png" alt="KUMAMOTO BAR NAVI"><span><b>KUMAMOTO</b><strong>BAR NAVI</strong><small>BAR & JOB INFORMATION</small></span></a></div></header><main class="container" style="padding:32px 18px 100px"><nav style="margin-bottom:20px"><a href="/">ホーム</a> › <b>掲載店舗一覧</b></nav><h1>熊本県の掲載BAR全店舗一覧</h1><p>${kbnSeoEsc(desc)}</p><div style="display:grid;gap:28px">${sections}</div></main></body></html>`;
}

async function ensureShopMaintenanceStatusColumn(env){
  try{
    await env.DB.prepare("ALTER TABLE shops ADD COLUMN business_status TEXT").run();
  }catch(e){
    const msg=String(e?.message||e||"").toLowerCase();
    if(!msg.includes("duplicate column")&&!msg.includes("already exists"))throw e;
  }
}

async function setShopMaintenanceAction(env,shopId,action){
  await ensureShopMaintenanceStatusColumn(env);
  const id=Math.max(1,Number(shopId)||0);
  const act=String(action||"");

  if(act==="operational"){
    await env.DB.prepare(`
      UPDATE shops
      SET business_status='OPERATIONAL',is_published=1,updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).bind(id).run();
  }else if(act==="temporary_closed"){
    await env.DB.prepare(`
      UPDATE shops
      SET business_status='CLOSED_TEMPORARILY',is_published=1,updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).bind(id).run();
  }else if(act==="unpublish"){
    await env.DB.prepare(`
      UPDATE shops
      SET business_status='UNPUBLISHED',is_published=0,updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).bind(id).run();
  }else{
    throw new Error("INVALID_MAINTENANCE_ACTION");
  }

  return await env.DB.prepare(`
    SELECT id,slug,name,area,is_published,business_status
    FROM shops WHERE id=? LIMIT 1
  `).bind(id).first();
}

async function ensureKbnAlertsTable(env){
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS kbn_admin_alerts(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT,
      shop_id INTEGER,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
}

async function createKbnAlert(env,{type,title,message="",shopId=null}){
  await ensureKbnAlertsTable(env);
  await env.DB.prepare(`
    INSERT INTO kbn_admin_alerts(alert_type,title,message,shop_id,is_read,created_at)
    VALUES(?,?,?,?,0,CURRENT_TIMESTAMP)
  `).bind(
    String(type||"info").slice(0,50),
    String(title||"お知らせ").slice(0,180),
    String(message||"").slice(0,2000),
    shopId===null?null:Number(shopId)
  ).run();
}

async function notifyCreatedShops(env,created,sourceLabel="自動開拓"){
  const rows=Array.isArray(created)?created:[];
  for(const x of rows.slice(0,30)){
    await createKbnAlert(env,{
      type:"new_shop",
      title:`新店舗を自動掲載: ${x.name||"店舗"}`,
      message:`${sourceLabel}で新しい店舗をKBN独自掲載しました。${x.area?` エリア: ${x.area}`:""}${x.genre?` / ${x.genre}`:""}`,
      shopId:x.shop_id||null
    });
  }
}


async function ensureKbnMaintenanceCursorTableV242(env){
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS kbn_maintenance_cursors(
      task TEXT PRIMARY KEY,
      after_id INTEGER NOT NULL DEFAULT 0,
      cycle_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
}

async function kbnMaintenanceCursorV242(env,task){
  await ensureKbnMaintenanceCursorTableV242(env);
  const key=String(task||"");
  const row=await env.DB.prepare(`
    SELECT task,after_id,cycle_count,updated_at
    FROM kbn_maintenance_cursors WHERE task=? LIMIT 1
  `).bind(key).first();
  return row||{task:key,after_id:0,cycle_count:0,updated_at:""};
}

async function kbnSaveMaintenanceCursorV242(env,task,nextAfterId,cycleCompleted=false){
  await ensureKbnMaintenanceCursorTableV242(env);
  const current=await kbnMaintenanceCursorV242(env,task);
  const next=cycleCompleted?0:Math.max(0,Number(nextAfterId)||0);
  const cycles=Number(current?.cycle_count||0)+(cycleCompleted?1:0);
  await env.DB.prepare(`
    INSERT INTO kbn_maintenance_cursors(task,after_id,cycle_count,updated_at)
    VALUES(?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(task) DO UPDATE SET
      after_id=excluded.after_id,
      cycle_count=excluded.cycle_count,
      updated_at=CURRENT_TIMESTAMP
  `).bind(String(task),next,cycles).run();
  return {after_id:next,cycle_count:cycles};
}

async function refreshMissingPublishedLiteV242(env,{limit=20,afterId=0}={}){
  const max=Math.max(1,Math.min(Number(limit)||20,20));
  const cursor=Math.max(0,Number(afterId)||0);
  const r=await env.DB.prepare(`
    SELECT id,name,area,address,hours,holiday,instagram,features,
           budget_min,budget_max,phone,is_published
    FROM shops
    WHERE COALESCE(is_published,1)=1
      AND id>?
      AND (
        COALESCE(TRIM(hours),'')='' OR
        COALESCE(TRIM(phone),'')='' OR
        budget_min IS NULL OR budget_max IS NULL OR
        COALESCE(TRIM(address),'')='' OR
        COALESCE(TRIM(features),'')=''
      )
    ORDER BY id ASC
    LIMIT ?
  `).bind(cursor,max).all();

  const rows=r.results||[];
  const updated=[],unchanged=[],failed=[];

  for(const shop of rows){
    try{
      const cleanName=String(shop.name||"").replace(/^【KBN独自掲載】/,"").trim();
      const found=await findGooglePlaceForShop(env,{name:cleanName,area:shop.area||"熊本"});
      if(!found.ok||!found.matched){
        unchanged.push({id:shop.id,name:shop.name,reason:found.error||"GOOGLE_MATCH_NOT_FOUND"});
        continue;
      }

      const details=await googlePlaceDetails(env,found.place?.id);
      const gp=details.ok&&details.place?details.place:found.place;

      const next={
        address:String(shop.address||"").trim() || t(googlePlaceAddress(gp)||"",500),
        hours:String(shop.hours||"").trim() || t(googleOpeningHours(gp)||"",800),
        holiday:String(shop.holiday||"").trim() || t(googleHolidayFromHours(gp)||"",180),
        phone:String(shop.phone||"").trim() || t(googlePhone(gp)||"",80),
        features:String(shop.features||"").trim() || t(googleDetailFeatures(gp)||"",1000),
        budget_min:shop.budget_min,
        budget_max:shop.budget_max
      };

      const price=googlePriceInfo(gp);
      if(next.budget_min==null && price?.min!=null)next.budget_min=price.min;
      if(next.budget_max==null && price?.max!=null)next.budget_max=price.max;

      const changed=
        String(next.address)!==String(shop.address||"") ||
        String(next.hours)!==String(shop.hours||"") ||
        String(next.holiday)!==String(shop.holiday||"") ||
        String(next.phone)!==String(shop.phone||"") ||
        String(next.features)!==String(shop.features||"") ||
        Number(next.budget_min??-1)!==Number(shop.budget_min??-1) ||
        Number(next.budget_max??-1)!==Number(shop.budget_max??-1);

      if(!changed){
        unchanged.push({id:shop.id,name:shop.name,reason:"NO_CHANGE"});
        continue;
      }

      await env.DB.prepare(`
        UPDATE shops SET
          address=?,hours=?,holiday=?,phone=?,features=?,
          budget_min=?,budget_max=?,updated_at=CURRENT_TIMESTAMP
        WHERE id=?
      `).bind(
        next.address,next.hours,next.holiday,next.phone,next.features,
        next.budget_min,next.budget_max,shop.id
      ).run();

      updated.push({id:shop.id,name:shop.name});
    }catch(e){
      failed.push({id:shop.id,name:shop.name,reason:String(e?.message||e).slice(0,250)});
    }
  }

  const nextAfterId=rows.length?Number(rows[rows.length-1].id||0):cursor;
  const more=await env.DB.prepare(`
    SELECT id FROM shops
    WHERE COALESCE(is_published,1)=1
      AND id>?
      AND (
        COALESCE(TRIM(hours),'')='' OR
        COALESCE(TRIM(phone),'')='' OR
        budget_min IS NULL OR budget_max IS NULL OR
        COALESCE(TRIM(address),'')='' OR
        COALESCE(TRIM(features),'')=''
      )
    ORDER BY id ASC LIMIT 1
  `).bind(nextAfterId).first();

  return {
    ok:true,checked:rows.length,updated,unchanged,failed,
    next_after_id:nextAfterId,has_more:!!more
  };
}


const KBN_SEO_SCORE_SQL_V312 = `
  (CASE WHEN TRIM(COALESCE(s.slug,''))!='' THEN 10 ELSE 0 END) +
  (CASE WHEN LENGTH(TRIM(COALESCE(s.name,'')))>=2 THEN 8 ELSE 0 END) +
  (CASE WHEN TRIM(COALESCE(s.area,''))!='' THEN 7 ELSE 0 END) +
  (CASE WHEN TRIM(COALESCE(s.address,''))!='' THEN 12 ELSE 0 END) +
  (CASE WHEN TRIM(COALESCE(s.hours,''))!='' THEN 15 ELSE 0 END) +
  (CASE WHEN TRIM(COALESCE(s.genre,''))!='' THEN 10 ELSE 0 END) +
  (CASE WHEN LENGTH(TRIM(COALESCE(s.description,'')))>=120 THEN 15
        WHEN LENGTH(TRIM(COALESCE(s.description,'')))>=80 THEN 10
        WHEN LENGTH(TRIM(COALESCE(s.description,'')))>=40 THEN 5 ELSE 0 END) +
  (CASE WHEN TRIM(COALESCE(s.image_url,''))!='' OR TRIM(COALESCE(s.image_key,''))!='' THEN 7 ELSE 0 END) +
  (CASE WHEN TRIM(COALESCE(s.instagram,''))!='' THEN 5 ELSE 0 END) +
  (CASE WHEN TRIM(COALESCE(s.phone,''))!='' THEN 4 ELSE 0 END) +
  (CASE WHEN TRIM(COALESCE(s.features,''))!='' THEN 3 ELSE 0 END) +
  (CASE WHEN TRIM(COALESCE(s.holiday,''))!='' THEN 2 ELSE 0 END) +
  (CASE WHEN COALESCE(s.budget_min,0)>0 OR COALESCE(s.budget_max,0)>0 OR COALESCE(s.seats,0)>0 THEN 2 ELSE 0 END)
`;

async function ensureKbnSeoAttemptTableV312(env){
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS kbn_seo_attempts(
      shop_id INTEGER PRIMARY KEY,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_score INTEGER NOT NULL DEFAULT 0,
      last_fields TEXT,
      last_attempt_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
}

async function refreshSeoPublishedV311(env,{limit=20,afterId=0}={}){
  await ensureKbnSeoAttemptTableV312(env);
  const max=Math.max(1,Math.min(Number(limit)||20,20));

  // v3.12: ID順ではなくSEOスコアが低い店舗を優先。
  // 同じ低スコア店舗だけを毎回触り続けないよう、最終試行が古い順で回す。
  const r=await env.DB.prepare(`
    SELECT s.id,s.name,s.area,s.address,s.hours,s.genre,s.features,s.description,
           s.holiday,s.instagram,s.phone,s.image_url,s.image_key,s.budget_min,s.budget_max,s.seats,
           s.is_published, (${KBN_SEO_SCORE_SQL_V312}) AS seo_score,
           a.last_attempt_at
    FROM shops s
    LEFT JOIN kbn_seo_attempts a ON a.shop_id=s.id
    WHERE COALESCE(s.is_published,1)=1
      AND (${KBN_SEO_SCORE_SQL_V312}) < 90
    ORDER BY (${KBN_SEO_SCORE_SQL_V312}) ASC,
             CASE WHEN a.last_attempt_at IS NULL THEN 0 ELSE 1 END ASC,
             COALESCE(a.last_attempt_at,'1970-01-01') ASC,
             s.id ASC
    LIMIT ?
  `).bind(max).all();

  const rows=r.results||[];
  const updated=[],unchanged=[],failed=[];

  for(const shop of rows){
    const beforeScore=Math.max(0,Math.min(100,Number(shop.seo_score||0)));
    let changedFields=[];
    try{
      const cleanName=String(shop.name||'').replace(/^【KBN独自掲載】/,'').trim();
      let nextAddress=String(shop.address||'').trim();
      let nextHours=String(shop.hours||'').trim();
      let nextGenre=String(shop.genre||'').trim();

      // 住所・営業時間は推測せず、Google Placesで店舗一致した場合のみ補完。
      if(!nextAddress || !nextHours){
        const found=await findGooglePlaceForShop(env,{name:cleanName,area:shop.area||'熊本'});
        if(found?.ok && found?.matched){
          const details=await googlePlaceDetails(env,found.place?.id);
          const gp=details?.ok&&details?.place?details.place:found.place;
          if(!nextAddress)nextAddress=t(googlePlaceAddress(gp)||'',500);
          if(!nextHours)nextHours=t(googleOpeningHours(gp)||'',800);
        }
      }

      // ジャンルは明確な語がある場合のみ安全側で補完。
      if(!nextGenre){
        const hay=`${cleanName} ${shop.features||''}`.toLowerCase();
        if(/スナック|snack/.test(hay))nextGenre='スナック';
        else if(/ダーツ|darts/.test(hay))nextGenre='ダーツBAR';
        else if(/カラオケ|karaoke/.test(hay))nextGenre='カラオケBAR';
        else if(/シーシャ|shisha|hookah/.test(hay))nextGenre='シーシャBAR';
        else if(/ワイン|wine/.test(hay))nextGenre='ワインBAR';
      }

      let nextDescription=String(shop.description||'').replace(/\s+/g,' ').trim();
      // v3.15: 説明文は「長さ」だけで埋めず、確認済みの店舗固有情報が2項目以上ある場合だけ強化。
      // 既存の紹介文は残し、店舗ごとに並び・表現を少し変えてテンプレートの完全重複を避ける。
      if(nextDescription.length<160){
        const area=String(shop.area||'').trim();
        const genre=nextGenre||String(shop.genre||'').trim();
        const feat=String(shop.features||'').replace(/\s+/g,' ').trim();
        const holiday=String(shop.holiday||'').trim();
        const budgetMin=Number(shop.budget_min||0), budgetMax=Number(shop.budget_max||0);
        const seats=Number(shop.seats||0);
        const facts=[];
        if(area)facts.push({k:'area',v:`${area}エリア`});
        if(genre)facts.push({k:'genre',v:`ジャンルは${genre}`});
        if(nextAddress)facts.push({k:'address',v:`所在地は${nextAddress}`});
        if(nextHours)facts.push({k:'hours',v:`営業時間は${nextHours}`});
        if(holiday)facts.push({k:'holiday',v:`定休日は${holiday}`});
        if(budgetMin>0||budgetMax>0){
          const b=budgetMin>0&&budgetMax>0?`${budgetMin.toLocaleString('ja-JP')}〜${budgetMax.toLocaleString('ja-JP')}円`:budgetMin>0?`${budgetMin.toLocaleString('ja-JP')}円〜`:`〜${budgetMax.toLocaleString('ja-JP')}円`;
          facts.push({k:'budget',v:`料金目安は${b}`});
        }
        if(seats>0)facts.push({k:'seats',v:`席数は${seats}席`});
        if(feat)facts.push({k:'features',v:`店舗の特徴として「${feat.slice(0,110)}」が掲載されています`});
        const strongFacts=facts.filter(x=>!['area','genre'].includes(x.k));
        if(strongFacts.length>=2){
          const seed=Math.abs(Number(shop.id||0))%3;
          const ordered=seed===1?[...facts.slice(1),facts[0]].filter(Boolean):seed===2?[...facts].reverse():facts;
          const factText=ordered.slice(0,6).map(x=>x.v).join('。');
          const intro=area&&genre?`${cleanName}は${area}で掲載中の${genre}です。`:area?`${cleanName}は${area}で掲載中の店舗です。`:genre?`${cleanName}は${genre}として掲載中です。`:`${cleanName}の店舗情報です。`;
          const original=nextDescription && !/KUMAMOTO BAR NAVIでは、店選びの比較/.test(nextDescription)?`${nextDescription.replace(/[。．]+$/,'')}。`:'';
          const close=seed===0?'営業時間や料金などは変更される場合があるため、来店前に店舗の最新情報をご確認ください。':seed===1?'掲載内容は変更されることがあります。来店前に営業時間・料金・予約可否などを店舗へご確認ください。':'営業状況や料金は変更される場合があります。最新情報は来店前に店舗へ直接ご確認ください。';
          nextDescription=t(`${intro}${original}${factText}。${close}`,5000);
        }
      }

      if(nextAddress!==String(shop.address||'').trim())changedFields.push('address');
      if(nextHours!==String(shop.hours||'').trim())changedFields.push('hours');
      if(nextGenre!==String(shop.genre||'').trim())changedFields.push('genre');
      if(nextDescription!==String(shop.description||'').replace(/\s+/g,' ').trim())changedFields.push('description');

      if(changedFields.length){
        await env.DB.prepare(`
          UPDATE shops SET address=?,hours=?,genre=?,description=?,updated_at=CURRENT_TIMESTAMP WHERE id=?
        `).bind(nextAddress,nextHours,nextGenre,nextDescription,shop.id).run();
        updated.push({id:shop.id,name:shop.name,fields:changedFields,score_before:beforeScore});
      }else{
        unchanged.push({id:shop.id,name:shop.name,reason:'NO_VERIFIED_CHANGE',score_before:beforeScore});
      }
    }catch(e){
      failed.push({id:shop.id,name:shop.name,reason:String(e?.message||e).slice(0,250),score_before:beforeScore});
    }finally{
      try{
        await env.DB.prepare(`
          INSERT INTO kbn_seo_attempts(shop_id,attempts,last_score,last_fields,last_attempt_at)
          VALUES(?,1,?,?,CURRENT_TIMESTAMP)
          ON CONFLICT(shop_id) DO UPDATE SET
            attempts=attempts+1,last_score=excluded.last_score,last_fields=excluded.last_fields,last_attempt_at=CURRENT_TIMESTAMP
        `).bind(shop.id,beforeScore,changedFields.join(',')).run();
      }catch{}
    }
  }

  const more=await env.DB.prepare(`
    SELECT COUNT(*) AS c FROM shops s
    WHERE COALESCE(s.is_published,1)=1 AND (${KBN_SEO_SCORE_SQL_V312}) < 90
  `).first();

  return {
    ok:true,checked:rows.length,updated,unchanged,failed,
    prioritized_by_score:true,
    next_after_id:0,
    has_more:Number(more?.c||0)>rows.length
  };
}

async function refreshInstagramPublishedV242(env,{limit=20,afterId=0}={}){
  const max=Math.max(1,Math.min(Number(limit)||20,20));
  const cursor=Math.max(0,Number(afterId)||0);

  const r=await env.DB.prepare(`
    SELECT id,name,area,instagram
    FROM shops
    WHERE COALESCE(is_published,1)=1
      AND COALESCE(TRIM(instagram),'')=''
      AND id>?
    ORDER BY id ASC
    LIMIT ?
  `).bind(cursor,max).all();

  const rows=r.results||[];
  const updated=[],candidates=[],failed=[];

  for(const shop of rows){
    try{
      const ig=await discoverInstagramForShop(env,{
        name:String(shop.name||"").replace(/^【KBN独自掲載】/,"").trim(),
        area:shop.area||"熊本",
        website:"",
        existing:""
      });

      if(ig?.instagram && Number(ig.score||0)>=90){
        await env.DB.prepare(`
          UPDATE shops SET instagram=?,updated_at=CURRENT_TIMESTAMP WHERE id=?
        `).bind(ig.instagram,shop.id).run();
        updated.push({id:shop.id,name:shop.name,instagram:ig.instagram,score:ig.score});
      }else if(ig?.candidates?.[0] && Number(ig.candidates[0].score||0)>=70){
        const c=ig.candidates[0];
        candidates.push({id:shop.id,name:shop.name,handle:c.handle,score:c.score});
      }
    }catch(e){
      failed.push({id:shop.id,name:shop.name,error:String(e?.message||e).slice(0,250)});
    }
  }

  const nextAfterId=rows.length?Number(rows[rows.length-1].id||0):cursor;
  const more=await env.DB.prepare(`
    SELECT id FROM shops
    WHERE COALESCE(is_published,1)=1
      AND COALESCE(TRIM(instagram),'')=''
      AND id>?
    ORDER BY id ASC LIMIT 1
  `).bind(nextAfterId).first();

  return {
    ok:true,checked:rows.length,updated,candidates,failed,
    next_after_id:nextAfterId,has_more:!!more
  };
}

async function runMaintenanceBatchV242(env,task,{limit=20}={}){
  const key=String(task||"");
  const cursor=await kbnMaintenanceCursorV242(env,key);
  const afterId=Math.max(0,Number(cursor?.after_id)||0);

  let result;
  if(key==="missing"){
    result=await refreshMissingPublishedLiteV242(env,{limit,afterId});
  }else if(key==="seo"){
    result=await refreshSeoPublishedV311(env,{limit,afterId});
  }else if(key==="closed"){
    result=await checkClosedShops(env,{limit,afterId});
  }else if(key==="instagram"){
    result=await refreshInstagramPublishedV242(env,{limit,afterId});
  }else{
    throw new Error("INVALID_MAINTENANCE_TASK");
  }

  const cycleCompleted=!result.has_more;
  const saved=await kbnSaveMaintenanceCursorV242(
    env,key,result.next_after_id,cycleCompleted
  );

  return {
    ...result,
    cursor_from:afterId,
    cursor_next:saved.after_id,
    cycle_completed:cycleCompleted,
    cycle_count:saved.cycle_count,
    task:key
  };
}

async function ensureKbnMaintenanceQueueV242(env){
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS kbn_maintenance_queue(
      id INTEGER PRIMARY KEY CHECK(id=1),
      phase INTEGER NOT NULL DEFAULT 0,
      run_date TEXT,
      created_total INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  // Existing DB compatibility.
  try{
    const info=await env.DB.prepare("PRAGMA table_info(kbn_maintenance_queue)").all();
    const names=new Set((info.results||[]).map(x=>String(x.name||"")));
    if(!names.has("created_total")){
      await env.DB.prepare("ALTER TABLE kbn_maintenance_queue ADD COLUMN created_total INTEGER NOT NULL DEFAULT 0").run();
    }
  }catch(e){
    const msg=String(e?.message||e||"");
    if(!/duplicate column/i.test(msg))throw e;
  }
}
async function kbnQueueMaintenanceV242(env,runDate,initialCreated=0){
  await ensureKbnMaintenanceQueueV242(env);
  // v2.89: 通常メンテナンス枠の新規掲載は、この直前に実行した最大20店舗だけ。
  // 追加の自動開拓キューは作らず、そのまま既存店メンテナンスへ進む。
  await env.DB.prepare(`
    INSERT INTO kbn_maintenance_queue(id,phase,run_date,created_total,updated_at)
    VALUES(1,1,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      phase=1,
      run_date=excluded.run_date,
      created_total=excluded.created_total,
      updated_at=CURRENT_TIMESTAMP
  `).bind(String(runDate||""),Math.max(0,Number(initialCreated)||0)).run();
}
async function kbnProcessQueuedMaintenanceV242(env){
  await ensureKbnMaintenanceQueueV242(env);
  const q=await env.DB.prepare(`
    SELECT phase,run_date,created_total,updated_at FROM kbn_maintenance_queue WHERE id=1
  `).first();

  const phase=Number(q?.phase||0);
  let createdTotal=Math.max(0,Number(q?.created_total||0));
  if(!phase)return {ok:true,processed:false};

  // v2.89: 旧バージョンで残っている追加自動開拓キュー(phase 11〜49)は廃止。
  // 新規掲載は通常メンテナンス開始時の最大20店舗だけにして、既存店チェックへ移行する。
  if(phase>=11 && phase<=49){
    await env.DB.prepare(`
      UPDATE kbn_maintenance_queue
      SET phase=1,updated_at=CURRENT_TIMESTAMP
      WHERE id=1
    `).run();
    return {
      ok:true,processed:true,phase,
      task:"discovery",
      discovery_skipped:true,
      reason:"MAINTENANCE_DISCOVERY_LIMIT_20",
      created_total:createdTotal
    };
  }

  // v3.11: 既存店メンテナンスにSEO改善20店舗を追加。
  // 情報不足 → SEO改善 → 閉業 → Instagram → 対象外候補 の順で進む。
  const task=phase===1?"missing":phase===2?"seo":phase===3?"closed":phase===4?"instagram":phase===5?"exclusion":"";
  if(!task){
    await env.DB.prepare(`
      UPDATE kbn_maintenance_queue
      SET phase=0,updated_at=CURRENT_TIMESTAMP
      WHERE id=1
    `).run();
    return {ok:true,processed:false};
  }

  let result;
  try{
    if(task==="exclusion"){
      result=await kbnScanExclusionCandidatesV267(env);
    }else{
      result=await runMaintenanceBatchV242(env,task,{limit:20});
    }
  }catch(e){
    console.error("queued maintenance failed",task,e);
    result={ok:false,error:String(e?.message||e),task};
  }

  const nextPhase=phase>=5?0:phase+1;
  await env.DB.prepare(`
    UPDATE kbn_maintenance_queue SET phase=?,updated_at=CURRENT_TIMESTAMP WHERE id=1
  `).bind(nextPhase).run();

  try{
    if(task==="exclusion"){
      const checked=Number(result?.checked||0);
      const candidateCount=Number(result?.candidate_count||0);
      await createKbnAlert(env,{
        type:"maintenance_exclusion_scan",
        title:"自動メンテナンス: 対象外候補チェック",
        message:`${checked}店舗を確認 / 対象外候補 ${candidateCount}件 / 店舗管理から確認できます`
      });
    }else{
      const checked=Number(result?.checked||0);
      const updated=Array.isArray(result?.updated)?result.updated.length:0;
      const closed=Array.isArray(result?.closed)?result.closed.length:0;
      await createKbnAlert(env,{
        type:"maintenance_batch",
        title:`自動メンテナンス: ${task==="seo"?"SEO自動改善":task}`,
        message:`${checked}店舗を確認 / 更新${updated}件${task==="closed"?` / 閉業候補${closed}件`:""}${task==="seo"?" / 営業時間・住所・説明文などを安全に補完":""} / 次回は続きから`
      });
    }
  }catch{}

  return {ok:true,processed:true,phase,task,result};
}
async function checkClosedShops(env,{limit=20,afterId=0}={}){
  await ensureKbnAlertsTable(env);
  await ensureShopMaintenanceStatusColumn(env);
  const max=Math.max(1,Math.min(Number(limit)||20,50));
  const cursor=Math.max(0,Number(afterId)||0);
  const r=await env.DB.prepare(`
    SELECT id,name,area,address,listing_status,is_published
    FROM shops
    WHERE is_published=1 AND id>?
    ORDER BY id ASC
    LIMIT ?
  `).bind(cursor,max).all();

  const checked=[],closed=[],failed=[];
  for(const shop of (r.results||[])){
    try{
      const found=await findGooglePlaceForShop(env,{
        name:String(shop.name||"").replace(/^【KBN独自掲載】/,"").trim(),
        area:shop.area||"熊本"
      });
      if(!found.ok||!found.matched){
        failed.push({id:shop.id,name:shop.name,reason:found.error||"GOOGLE_MATCH_NOT_FOUND"});
        continue;
      }
      const details=await googlePlaceDetails(env,found.place?.id);
      const gp=details.ok&&details.place?details.place:found.place;
      const status=String(gp?.businessStatus||"").toUpperCase();
      checked.push({id:shop.id,name:shop.name,business_status:status||"UNKNOWN"});
      if(status==="CLOSED_PERMANENTLY"||status==="CLOSED_TEMPORARILY"){
        const already=await env.DB.prepare(`
          SELECT id FROM kbn_admin_alerts
          WHERE alert_type='closed_shop' AND shop_id=? AND is_read=0
          LIMIT 1
        `).bind(shop.id).first();
        if(!already){
          await createKbnAlert(env,{
            type:"closed_shop",
            title:status==="CLOSED_PERMANENTLY"?"閉業の可能性":"一時休業の可能性",
            message:`Google Placesで「${shop.name}」が${status==="CLOSED_PERMANENTLY"?"閉業":"一時休業"}として確認されました。掲載状態を確認してください。`,
            shopId:shop.id
          });
        }
        closed.push({id:shop.id,name:shop.name,business_status:status});
      }
    }catch(e){
      failed.push({id:shop.id,name:shop.name,reason:String(e?.message||e||"UNKNOWN").slice(0,300)});
    }
  }

  const nextAfterId=(r.results||[]).length?Number(r.results[r.results.length-1].id||0):cursor;
  const more=await env.DB.prepare(`
    SELECT id FROM shops WHERE is_published=1 AND id>? ORDER BY id ASC LIMIT 1
  `).bind(nextAfterId).first();

  return {ok:true,checked,closed,failed,next_after_id:nextAfterId,has_more:!!more};
}


async function enrichScheduledCreatedShops(env,created=[]){
  const rows=Array.isArray(created)?created:[];
  const images={checked:0,updated:[],failed:[]};
  const instagram={checked:0,updated:[],candidates:[],failed:[]};

  for(const item of rows){
    const id=Number(item?.shop_id||item?.id||0);
    if(!id)continue;

    const shop=await env.DB.prepare(`
      SELECT id,name,area,address,image_url,image_key,instagram
      FROM shops WHERE id=? LIMIT 1
    `).bind(id).first();
    if(!shop)continue;

    const cleanName=String(shop.name||"").replace(/^【KBN独自掲載】/,"").trim();

    // 画像：新規掲載店舗は必ずGoogle Places写真を確認して補完
    images.checked++;
    try{
      const hasGooglePhoto=String(shop.image_key||"").startsWith("google:");
      if(!hasGooglePhoto){
        const found=await findGooglePlaceForShop(env,{
          name:cleanName,
          area:shop.area||"熊本"
        });
        if(found.ok&&found.matched){
          const details=await googlePlaceDetails(env,found.place?.id);
          const gp=details.ok&&details.place?details.place:found.place;
          const photoName=googlePhotoName(gp);
          if(photoName){
            const imageUrl=googlePhotoProxyUrl(id);
            await env.DB.prepare(`
              UPDATE shops
              SET image_url=?,image_key=?,updated_at=CURRENT_TIMESTAMP
              WHERE id=?
            `).bind(imageUrl,`google:${photoName}`,id).run();
            images.updated.push({id,name:shop.name,image_url:imageUrl});
          }
        }
      }
    }catch(e){
      images.failed.push({id,name:shop.name,error:String(e?.message||e).slice(0,250)});
    }

    // Instagram：既存値が無い新規掲載店舗のみ高信頼候補を自動掲載
    instagram.checked++;
    try{
      if(!String(shop.instagram||"").trim()){
        let website="";
        const found=await findGooglePlaceForShop(env,{
          name:cleanName,
          area:shop.area||"熊本"
        });

        if(found.ok&&found.matched){
          const details=await googlePlaceDetails(env,found.place?.id);
          const gp=details.ok&&details.place?details.place:found.place;
          website=googleWebsite(gp)||"";
        }

        const ig=await discoverInstagramForShop(env,{
          name:cleanName,
          area:shop.area||"熊本",
          website,
          existing:""
        });

        if(ig?.instagram && Number(ig.score||0)>=90){
          await env.DB.prepare(`
            UPDATE shops
            SET instagram=?,updated_at=CURRENT_TIMESTAMP
            WHERE id=?
          `).bind(ig.instagram,id).run();
          instagram.updated.push({
            id,name:shop.name,instagram:ig.instagram,
            score:Number(ig.score||0),source:ig.source||""
          });
        }else if(ig?.candidates?.[0] && Number(ig.candidates[0].score||0)>=70){
          instagram.candidates.push({
            id,name:shop.name,
            handle:ig.candidates[0].handle||"",
            score:Number(ig.candidates[0].score||0)
          });
        }
      }
    }catch(e){
      instagram.failed.push({id,name:shop.name,error:String(e?.message||e).slice(0,250)});
    }
  }

  return {images,instagram};
}

// KBN v2.12: 自動開拓上限50店舗・完全削除履歴を保存して再掲載防止
// KBN v2.07: 自動掲載店舗一覧スマート化・完全削除
// KBN v2.06: 自動掲載店舗の300件上限を撤廃・全件ページ取得対応
// KBN v2.05: 管理画面で無料会員数・会員情報を確認
// KBN v2.01: 求人削除APIを追加
// KBN v1.99: 承認済み申込みから求人を再検出し確認後に公開
// KBN v1.98: 備考・説明欄の求人情報も自動判定・抽出して求人掲載
// KBN v1.97: 求人付き掲載申込みを承認時に求人へ自動反映・公開
// KBN free member v1.93: PBKDF2 iteration compatibility fix
// KBN free member v1.92: D1 schema compatibility + register diagnostics
// KBN free member v1.91: registration response reliability fix
// KBN free member v1.90: registration, login, favorites, email opt-in
// KBN Google reviews v1.84: public rating + up to 3 reviews
// KBN admin file create v1.83: missing GitHub file => create, existing => overwrite
// KBN admin file permission v1.82: allow robots.txt / sitemap.xml
// KBN scheduled maintenance v1.81:
 // target 15 listings, multi-pass discovery + image + Instagram enrichment
async function runScheduledKbnMaintenance(env){
  // v2.89:
  // 選択した通常メンテナンス回でも、まず新規掲載を最大20店舗まで実行。
  // その後は追加の自動開拓を行わず、情報不足20件 → 閉業20件 → Instagram20件 → 対象外候補チェックへ進む。
  const discoveryResult=await runScheduledKbnAutoDiscoveryOnly(env);

  const now=new Date(Date.now()+9*60*60*1000);
  const runDate=`${now.getUTCFullYear()}-${String(now.getUTCMonth()+1).padStart(2,"0")}-${String(now.getUTCDate()).padStart(2,"0")}`;
  await kbnQueueMaintenanceV242(env,runDate,Number(discoveryResult?.discovery?.created?.length||0));

  await createKbnAlert(env,{
    type:"scheduled_summary",
    title:"予約メンテナンス開始",
    message:"新規掲載を最大20店舗まで実行した後、情報不足20店舗 → 閉業20店舗 → Instagram20店舗 → 対象外候補チェックを順番に実行します。"
  });

  return {
    ...discoveryResult,
    maintenance_queued:true,
    maintenance_batch_size:20,
    discovery_batches:1,
    discovery_target_max:20
  };
}


// KBN v2.28: 重複をDetails前に除外し、新規候補探索を強化。
// KBN v2.27: Cloudflare Workers Free 50 subrequests/invocation 対策。
// KBN v2.15: 追加Cronでは「自動掲載」に関係する処理だけを実行。
// 既存店舗の情報補完・画像補完・Instagram補完・閉業チェックは実行しない。
async function runScheduledKbnAutoDiscoveryOnly(env){
  const fakeRequest=new Request("https://kumamoto-bar-navi.rrwpvwmz8p.workers.dev/api/internal/scheduled-auto-only");
  // v2.54 Free枠: 1 invocation 最大10店舗は維持。
  // 未開拓地区優先ロジックを使い、5地区×1回を複数Cronに分割して安全に積み上げる。
  // v2.91: 0件でも途中終了せず、候補がある限り重複なしで最大7地区まで探索して最大20店舗を狙う。
  // 1回のautoDiscover内でまとめて探索することで、OSM/Geoapifyの共通取得を使い回し、
  // 複数pass方式よりCloudflare Free枠のsubrequestを抑える。
  const targetListings=20;
  const maxPasses=1;
  const allCreated=[];
  const allSearched=[];
  const allRejected=[];
  const passStats=[];

  for(let pass=1;pass<=maxPasses && allCreated.length<targetListings;pass++){
    const remaining=targetListings-allCreated.length;
    const result=await autoDiscover(
      env,
      fakeRequest,
      remaining,
      7,  // v2.91: 未開拓優先で「実際に異なる7地区」まで探索
      4,  // 1地区あたり最大4店舗。Details上限も4件でFree枠を守る
      true // 同一地区の別ジャンルを重複カウントしない
    );

    const created=Array.isArray(result?.created)?result.created:[];
    const searched=Array.isArray(result?.searched)?result.searched:[];
    const rejected=Array.isArray(result?.rejected)?result.rejected:[];

    for(const x of created){
      const key=Number(x?.shop_id||x?.id||0)||`${x?.name||""}|${x?.area||""}`;
      if(!allCreated.some(y=>{
        const yk=Number(y?.shop_id||y?.id||0)||`${y?.name||""}|${y?.area||""}`;
        return yk===key;
      })){
        allCreated.push(x);
      }
      if(allCreated.length>=targetListings)break;
    }

    allSearched.push(...searched);
    allRejected.push(...rejected);
    passStats.push({
      pass,
      created:created.length,
      total:allCreated.length,
      searched:searched.length,
      rejected:rejected.length
    });

    if(result?.ok===false && result?.error==="DISCOVERY_SOURCES_UNAVAILABLE")break;
  }

  const created=allCreated.slice(0,targetListings);

  // v2.27 Free枠: 新規直後の画像/Instagram追加fetchは通常メンテナンスへ分離。
  const createdEnrichment={images:{updated:[]},instagram:{updated:[]}};

  if(created.length){
    await notifyCreatedShops(env,created,"予約自動開拓（追加枠）");
    try{
      await kbnSendNewListingDigest(env,created);
    }catch(e){
      console.error("member new listing digest failed",e);
    }
  }

  await createKbnAlert(env,{
    type:"scheduled_discovery_summary",
    title:"追加の予約自動開拓完了",
    message:[
      `新規掲載 ${created.length}/${targetListings}店舗`,
      `探索 ${Math.min(7,new Set(allSearched.map(x=>String(x?.area||"").trim()).filter(Boolean)).size)}地区`,
      `画像 ${createdEnrichment?.images?.updated?.length||0}件`,
      `Instagram ${createdEnrichment?.instagram?.updated?.length||0}件`
    ].join(" / ")
  });

  return {
    discovery:{
      ok:true,
      created,
      searched:allSearched,
      rejected:allRejected,
      target:targetListings,
      passes:passStats.length,
      districts_searched:new Set(allSearched.map(x=>String(x?.area||"").trim()).filter(Boolean)).size,
      district_limit:7,
      pass_stats:passStats
    },
    created_enrichment:createdEnrichment
  };
}

// v2.95: Core Web Vitals / public delivery hardening.
// Keep admin uncached, but allow browsers/CDN to reuse public static assets.
function kbnApplyPublicPerformanceHeaders(response,url){
  const h=new Headers(response.headers);
  const path=String(url.pathname||"").toLowerCase();
  const isHtml=path==="/" || path.endsWith(".html") || path==="/shop" || path==="/all-shops" || path.startsWith("/area/") || path.startsWith("/genre/");
  const isCss=path.endsWith(".css");
  const isJs=path.endsWith(".js");
  const isImage=/\.(?:png|jpe?g|webp|avif|gif|svg|ico)$/.test(path);
  const isFont=/\.(?:woff2?|ttf|otf)$/.test(path);

  if(isCss || isJs){
    h.set("Cache-Control","public, max-age=86400, stale-while-revalidate=604800");
  }else if(isImage || isFont){
    h.set("Cache-Control","public, max-age=604800, stale-while-revalidate=2592000");
  }else if(isHtml && response.ok){
    h.set("Cache-Control","public, max-age=300, stale-while-revalidate=1800");
  }

  // Small, safe transport hints. Vary only when already required by the origin.
  h.set("X-Content-Type-Options","nosniff");
  h.set("Referrer-Policy","strict-origin-when-cross-origin");
  h.set("X-KBN-Performance","cwv-v295");
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers:h});
}

function kbnInjectCwvHints(html,primaryImageUrl=""){
  let out=String(html||"");
  if(!out)return out;
  const hints=[];
  // style.css is required for first paint. preload starts it early without changing CSS behavior.
  if(/<link[^>]+rel=["']stylesheet["'][^>]+href=["'][^"']*style\.css/i.test(out)){
    const m=out.match(/<link[^>]+rel=["']stylesheet["'][^>]+href=["']([^"']*style\.css[^"']*)["'][^>]*>/i);
    if(m?.[1])hints.push(`<link rel="preload" href="${kbnSeoEsc(m[1])}" as="style">`);
  }
  if(primaryImageUrl){
    hints.push(`<link rel="preload" href="${kbnSeoEsc(primaryImageUrl)}" as="image" fetchpriority="high">`);
  }
  if(hints.length && !/data-kbn-cwv-hints=/.test(out)){
    out=out.replace(/<head([^>]*)>/i,`<head$1><meta data-kbn-cwv-hints="v295">${hints.join("")}`);
  }
  // Avoid spending layout/paint work on sections far below the fold until they approach viewport.
  if(!/data-kbn-cwv-css=/.test(out)){
    out=out.replace(/<\/head>/i,`<style data-kbn-cwv-css="v295">@supports(content-visibility:auto){.local-seo-list,.local-seo-guide,.local-seo-faq,.kbn-seo-related,.kbn-seo-link-hub{content-visibility:auto;contain-intrinsic-size:1px 700px}}</style></head>`);
  }
  return out;
}

export default {
  async fetch(request, env, ctx) {
    const url=new URL(request.url);

    if(request.method==="GET" && url.pathname==="/logo.png"){
      const bytes=kbnLogo192PngBytesV296();
      return new Response(bytes,{headers:{
        "Content-Type":"image/png",
        "Cache-Control":"public, max-age=31536000, immutable",
        "Content-Length":String(bytes.byteLength),
        "X-KBN-Asset":"logo-192-v296"
      }});
    }

    // v2.86: Search Console redirect-error fix for legacy SEO landing pages.
    // Cloudflare Static Assets defaults to auto-trailing-slash, where /file.html is
    // redirected to /file. These pages intentionally use the .html URL as canonical,
    // so run them through the Worker and serve the extensionless asset body directly
    // with a 200 response at the original .html URL.
    const kbnSeoHtml200Paths=new Set([
      "/kumamoto-bar.html",
      "/shimotori-bar.html",
      "/karaoke-bar-kumamoto.html",
      "/darts-bar-kumamoto.html",
      "/snack-kumamoto.html",
      "/kumamoto-station-bar.html",
      "/suizenji-bar.html",
      "/kengun-bar.html",
      "/hikarinomori-bar.html",
      "/yatsushiro-bar.html",
      "/hitoyoshi-bar.html",
      "/tamana-bar.html",
      "/amakusa-bar.html"
    ]);
    if(request.method==="GET" && kbnSeoHtml200Paths.has(url.pathname)){
      const assetUrl=new URL(request.url);
      assetUrl.pathname=url.pathname.replace(/\.html$/i,"");
      const raw=await env.ASSETS.fetch(new Request(assetUrl.toString(),request));
      if(raw.status===200){
        const headers=new Headers(raw.headers);
        headers.delete("location");
        headers.set("content-type","text/html; charset=utf-8");
        headers.set("cache-control","public, max-age=900");
        headers.set("x-robots-tag","index, follow, max-image-preview:large");
        headers.set("x-kbn-seo-route","direct-html-200-v286");
        return new Response(raw.body,{status:200,statusText:"OK",headers});
      }
      // If the canonical asset cannot be loaded, do not manufacture another redirect.
      return new Response("SEO page temporarily unavailable",{
        status:503,
        headers:{"content-type":"text/plain; charset=utf-8","cache-control":"no-store","x-robots-tag":"noindex, nofollow"}
      });
    }

    const localSeoAreaMatch=url.pathname.match(/^\/area\/([a-z0-9-]+)\/?$/);
    if(localSeoAreaMatch && request.method==="GET"){
      const html=await renderLocalSeoAreaPage(env,localSeoAreaMatch[1]);
      if(!html)return new Response("Not Found",{status:404});
      return new Response(kbnInjectCwvHints(html),{headers:{"content-type":"text/html; charset=utf-8","cache-control":"public, max-age=300, stale-while-revalidate=1800"}});
    }



    const localSeoAreaGenreMatch=url.pathname.match(/^\/area\/([a-z0-9-]+)\/([a-z0-9-]+)\/?$/);
    if(localSeoAreaGenreMatch && request.method==="GET"){
      const html=await renderLocalSeoAreaGenrePage(env,localSeoAreaGenreMatch[1],localSeoAreaGenreMatch[2]);
      if(!html)return new Response("Not Found",{status:404,headers:{"x-robots-tag":"noindex, follow"}});
      return new Response(kbnInjectCwvHints(html),{headers:{"content-type":"text/html; charset=utf-8","cache-control":"public, max-age=300, stale-while-revalidate=1800"}});
    }

    const localSeoGenreMatch=url.pathname.match(/^\/genre\/([a-z0-9-]+)\/?$/);
    if(localSeoGenreMatch && request.method==="GET"){
      const html=await renderLocalSeoGenrePage(env,localSeoGenreMatch[1]);
      if(!html)return new Response("Not Found",{status:404});
      return new Response(kbnInjectCwvHints(html),{headers:{"content-type":"text/html; charset=utf-8","cache-control":"public, max-age=300, stale-while-revalidate=1800"}});
    }

    if((url.pathname==="/shop" || url.pathname==="/shop.html") && request.method==="GET"){
      const shopSlug=String(url.searchParams.get("slug")||"").trim();

      // The template itself is not a public landing page. Keep no-slug requests out of Google,
      // while real shop URLs below are always rendered with an explicit index directive.
      if(!shopSlug){
        return new Response(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,follow"><title>店舗詳細｜KUMAMOTO BAR NAVI</title></head><body><main><h1>店舗が指定されていません</h1><p><a href="/bars.html">BARを探す</a></p></main></body></html>`,{
          status:200,
          headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-cache, max-age=0, must-revalidate","x-robots-tag":"noindex, follow"}
        });
      }

      // Keep one canonical public URL. Older /shop.html links are permanently redirected.
      if(url.pathname==="/shop.html"){
        const canonicalUrl=new URL("/shop",url.origin);
        canonicalUrl.searchParams.set("slug",shopSlug);
        return Response.redirect(canonicalUrl.toString(),301);
      }

      const seoShop=await renderSeoShopDetailV250(request,env,url);
      if(seoShop)return seoShop;

      // Never fall through to the raw asset for a real shop URL: that could reintroduce stale
      // template directives. A temporary failure is safer than accidentally serving noindex.
      return new Response("Temporary shop rendering error",{
        status:503,
        headers:{"content-type":"text/plain; charset=utf-8","cache-control":"no-store","x-robots-tag":"noindex, nofollow"}
      });
    }

    if((url.pathname==="/all-shops" || url.pathname==="/all-shops/") && request.method==="GET"){
      return new Response(kbnInjectCwvHints(await renderAllShopsSeoIndexV250(env,url.origin)),{
        headers:{"content-type":"text/html; charset=utf-8","cache-control":"public, max-age=300, stale-while-revalidate=1800","x-robots-tag":"index, follow"}
      });
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

    const sitemapLastmodDate=value=>{
      const raw=String(value||"").trim();
      if(!raw)return "";

      // Google sitemapのlastmodはYYYY-MM-DDだけに統一。
      // D1のCURRENT_TIMESTAMP形式、ISO形式、旧データの日時形式でも日付部分だけ採用。
      const m=raw.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
      if(m){
        const y=Number(m[1]),mo=Number(m[2]),d=Number(m[3]);
        const dt=new Date(Date.UTC(y,mo-1,d));
        if(
          dt.getUTCFullYear()===y &&
          dt.getUTCMonth()===mo-1 &&
          dt.getUTCDate()===d
        ){
          return `${String(y).padStart(4,"0")}-${String(mo).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
        }
      }

      // Unix秒/ミリ秒などの旧値が混在していても、有効な場合だけ採用。
      if(/^\d{10,13}$/.test(raw)){
        const n=Number(raw);
        const dt=new Date(raw.length===10?n*1000:n);
        if(!Number.isNaN(dt.getTime()))return dt.toISOString().slice(0,10);
      }

      // それ以外は無効なlastmodを出さない。
      return "";
    };

    // Split sitemap architecture: the submitted /sitemap.xml is an index.
    // This makes Search Console discover static/area pages and every public shop separately,
    // and keeps the shop inventory scalable as listings grow.
    if((url.pathname==="/sitemap.xml" || url.pathname==="/sitemap-index.xml") && request.method==="GET"){
      const base="https://kumamoto-bar-navi.rrwpvwmz8p.workers.dev";
      const now=new Date().toISOString().slice(0,10);
      const xml=`<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${base}/sitemap-pages.xml</loc><lastmod>${now}</lastmod></sitemap>
  <sitemap><loc>${base}/sitemap-shops.xml</loc><lastmod>${now}</lastmod></sitemap>
</sitemapindex>`;
      return new Response(xml,{headers:{
        "content-type":"application/xml; charset=utf-8",
        "cache-control":"no-cache, max-age=0, must-revalidate",
        "x-robots-tag":"noindex"
      }});
    }

    if(url.pathname==="/sitemap-pages.xml" && request.method==="GET"){
      const base="https://kumamoto-bar-navi.rrwpvwmz8p.workers.dev";
      const urls=[
        {loc:`${base}/`,priority:"1.0",freq:"daily"},
        {loc:`${base}/bars.html`,priority:"0.9",freq:"daily"},
        {loc:`${base}/jobs.html`,priority:"0.8",freq:"daily"},
        {loc:`${base}/column.html`,priority:"0.6",freq:"weekly"},
        {loc:`${base}/areas.html`,priority:"0.8",freq:"weekly"},
        {loc:`${base}/all-shops`,priority:"0.9",freq:"daily"},
        {loc:`${base}/listing-form.html`,priority:"0.6",freq:"monthly"},
        {loc:`${base}/about.html`,priority:"0.5",freq:"monthly"},
        {loc:`${base}/faq.html`,priority:"0.5",freq:"monthly"},
        {loc:`${base}/contact.html`,priority:"0.4",freq:"monthly"}
      ];
      // Area pages are included only when at least one public shop exists.
      // This avoids sending empty/thin location pages to Google while keeping new areas automatic.
      let liveAreas=new Set();
      try{
        const areaRes=await env.DB.prepare(`
          SELECT DISTINCT area FROM shops
          WHERE COALESCE(is_published,1)=1 AND COALESCE(slug,'')<>'' AND COALESCE(area,'')<>''
        `).all();
        liveAreas=new Set((areaRes.results||[]).map(r=>String(r.area||'').trim()).filter(Boolean));
      }catch(e){ console.error("sitemap area inventory",e); }
      for(const [slug,areaName] of Object.entries(KBN_LOCAL_SEO_AREAS||{})){
        if(liveAreas.size && !liveAreas.has(areaName))continue;
        urls.push({loc:`${base}/area/${encodeURIComponent(slug)}`,priority:"0.8",freq:"daily"});
      }
      // Genre landing pages are included only when at least 3 matching public shops exist.
      // This prevents thin genre pages from being submitted while allowing useful pages to appear automatically.
      try{
        for(const [gslug,gcfg] of Object.entries(KBN_LOCAL_SEO_GENRES||{})){
          const terms=gcfg.terms||[];
          if(!terms.length)continue;
          const cond=terms.map(()=>`LOWER(COALESCE(genre,'') || ' ' || COALESCE(features,'') || ' ' || COALESCE(description,'') || ' ' || COALESCE(hours,'')) LIKE ?`).join(' OR ');
          const row=await env.DB.prepare(`SELECT COUNT(*) AS total FROM shops WHERE COALESCE(is_published,1)=1 AND COALESCE(slug,'')<>'' AND (${cond})`).bind(...terms.map(t=>`%${String(t).toLowerCase()}%`)).first();
          if(Number(row?.total||0)>=3)urls.push({loc:`${base}/genre/${encodeURIComponent(gslug)}`,priority:"0.8",freq:"daily"});
        }
      }catch(e){ console.error("sitemap genre inventory",e); }
      // Area × genre pages: only submit combinations with at least 5 public shops.
      // We aggregate by area per genre (one grouped query per genre), avoiding hundreds of D1 queries.
      try{
        const areaSlugByName=new Map(Object.entries(KBN_LOCAL_SEO_AREAS||{}).map(([slug,name])=>[String(name||'').trim(),slug]));
        for(const [gslug,gcfg] of Object.entries(KBN_LOCAL_SEO_GENRES||{})){
          const {terms,condition,binds}=kbnGenreSqlParts(gcfg);
          if(!terms.length||!condition)continue;
          const rr=await env.DB.prepare(`SELECT area,COUNT(*) AS total FROM shops WHERE COALESCE(is_published,1)=1 AND COALESCE(slug,'')<>'' AND COALESCE(area,'')<>'' AND (${condition}) GROUP BY area HAVING COUNT(*)>=5`).bind(...binds).all();
          for(const row of (rr.results||[])){
            const aslug=areaSlugByName.get(String(row.area||'').trim());
            if(!aslug)continue;
            urls.push({loc:`${base}/area/${encodeURIComponent(aslug)}/${encodeURIComponent(gslug)}`,priority:"0.75",freq:"daily"});
          }
        }
      }catch(e){ console.error("sitemap area genre inventory",e); }
      const escXml=v=>String(v||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");
      const xml=`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(x=>`  <url>\n    <loc>${escXml(x.loc)}</loc>\n    <changefreq>${x.freq}</changefreq>\n    <priority>${x.priority}</priority>\n  </url>`).join("\n")}\n</urlset>`;
      return new Response(xml,{headers:{"content-type":"application/xml; charset=utf-8","cache-control":"no-cache, max-age=0, must-revalidate","x-robots-tag":"noindex"}});
    }

    if(url.pathname==="/sitemap-shops.xml" && request.method==="GET"){
      const base="https://kumamoto-bar-navi.rrwpvwmz8p.workers.dev";
      const urls=[];
      if(env.DB){
        try{
          const r=await env.DB.prepare(`
            SELECT slug,updated_at
            FROM shops
            WHERE COALESCE(is_published,1)=1
              AND TRIM(COALESCE(slug,''))<>''
            ORDER BY COALESCE(updated_at,published_at,created_at) DESC, id DESC
            LIMIT 45000
          `).all();
          const seen=new Set();
          for(const row of (r.results||[])){
            const slug=String(row.slug||"").trim();
            if(!slug)continue;
            const loc=`${base}/shop?slug=${encodeURIComponent(slug)}`;
            if(seen.has(loc))continue;
            seen.add(loc);
            urls.push({loc,lastmod:sitemapLastmodDate(row.updated_at)});
          }
        }catch(e){ console.error("shop sitemap generation error",e); }
      }
      // Genre landing pages are included only when at least 3 matching public shops exist.
      // This prevents thin genre pages from being submitted while allowing useful pages to appear automatically.
      try{
        for(const [gslug,gcfg] of Object.entries(KBN_LOCAL_SEO_GENRES||{})){
          const terms=gcfg.terms||[];
          if(!terms.length)continue;
          const cond=terms.map(()=>`LOWER(COALESCE(genre,'') || ' ' || COALESCE(features,'') || ' ' || COALESCE(description,'') || ' ' || COALESCE(hours,'')) LIKE ?`).join(' OR ');
          const row=await env.DB.prepare(`SELECT COUNT(*) AS total FROM shops WHERE COALESCE(is_published,1)=1 AND COALESCE(slug,'')<>'' AND (${cond})`).bind(...terms.map(t=>`%${String(t).toLowerCase()}%`)).first();
          if(Number(row?.total||0)>=3)urls.push({loc:`${base}/genre/${encodeURIComponent(gslug)}`,priority:"0.8",freq:"daily"});
        }
      }catch(e){ console.error("sitemap genre inventory",e); }
      const escXml=v=>String(v||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");
      const xml=`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(x=>`  <url>\n    <loc>${escXml(x.loc)}</loc>${x.lastmod?`\n    <lastmod>${escXml(x.lastmod)}</lastmod>`:""}\n    <changefreq>weekly</changefreq>\n    <priority>0.8</priority>\n  </url>`).join("\n")}\n</urlset>`;
      return new Response(xml,{headers:{
        "content-type":"application/xml; charset=utf-8",
        "cache-control":"no-cache, max-age=0, must-revalidate",
        "x-robots-tag":"noindex",
        "x-kbn-shop-url-count":String(urls.length)
      }});
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

    if(url.pathname==="/api/shop-photo" && request.method==="GET"){
      const id=Math.max(0,Number(url.searchParams.get("id")||0));
      if(!id)return new Response("Not found",{status:404});
      const shop=await env.DB.prepare("SELECT image_key FROM shops WHERE id=? AND COALESCE(is_published,1)=1").bind(id).first();
      const key=String(shop?.image_key||"");
      if(!key.startsWith("google:"))return new Response("Not found",{status:404});
      const photoName=key.slice(7);
      if(!/^places\/[^/]+\/photos\/[^/]+$/.test(photoName))return new Response("Not found",{status:404});
      const cfg=googlePlacesConfig(env);
      if(!cfg.apiKey)return new Response("Photo service unavailable",{status:503});
      const requestedWidth=Math.max(240,Math.min(1200,Number(url.searchParams.get("w")||640)));
      const endpoint=`https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=${requestedWidth}&skipHttpRedirect=true&key=${encodeURIComponent(cfg.apiKey)}`;
      try{
        const metaRes=await fetch(endpoint,{headers:{"Accept":"application/json"}});
        if(!metaRes.ok)return new Response("Photo unavailable",{status:metaRes.status});
        const meta=await metaRes.json();
        const photoUri=String(meta?.photoUri||"");
        if(!/^https:\/\//i.test(photoUri))return new Response("Photo unavailable",{status:404});
        const img=await fetch(photoUri);
        if(!img.ok)return new Response("Photo unavailable",{status:img.status});
        const h=new Headers(img.headers);
        h.set("Cache-Control","public, max-age=604800, stale-while-revalidate=2592000");
        h.set("Vary","Accept");
        h.delete("set-cookie");
        return new Response(img.body,{status:200,headers:h});
      }catch(e){
        return new Response("Photo unavailable",{status:502});
      }
    }

    if(url.pathname==="/api/shops" && request.method==="GET"){
      if(url.searchParams.get("homeStats")==="1"){
        const row=await env.DB.prepare(`
          SELECT COUNT(*) AS shop_count, COUNT(DISTINCT NULLIF(TRIM(area),'')) AS area_count
          FROM shops WHERE is_published=1
        `).first();
        return json({ok:true,shop_count:Number(row?.shop_count||0),area_count:Number(row?.area_count||0)},{headers:{"Cache-Control":"public, max-age=30, stale-while-revalidate=120"}});
      }
      if(url.searchParams.get("homeCards")==="1"){
        const r=await env.DB.prepare(`
          SELECT * FROM shops WHERE is_published=1
          ORDER BY is_featured DESC, COALESCE(updated_at,published_at,created_at) DESC, sort_order ASC, id DESC
          LIMIT 14
        `).all();
        return json({ok:true,shops:(r.results||[]).map(publicShopRow)},{headers:{"Cache-Control":"public, max-age=60, stale-while-revalidate=300"}});
      }
      if(url.searchParams.get("featuredRandomOfficial")==="291"){
        const r=await env.DB.prepare(`
          SELECT * FROM shops
          WHERE is_published=1 AND COALESCE(listing_status,'published') <> 'provisional'
          ORDER BY RANDOM() LIMIT 6
        `).all();
        return json({ok:true,shops:(r.results||[]).map(publicShopRow)},{headers:{"Cache-Control":"public, max-age=60, stale-while-revalidate=300"}});
      }
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

    const googleReviewsMatch=url.pathname.match(/^\/api\/shops\/([^/]+)\/google-reviews$/);
    if(googleReviewsMatch && request.method==="GET"){
      const slug=decodeURIComponent(googleReviewsMatch[1]);
      const s=await env.DB.prepare(`
        SELECT id,slug,name,area,address
        FROM shops
        WHERE slug=? AND is_published=1
        LIMIT 1
      `).bind(slug).first();

      if(!s){
        return json({ok:false,error:"NOT_FOUND"},{status:404});
      }

      const cleanName=String(s.name||"")
        .replace(/^【KBN独自掲載】/,"")
        .replace(/\s*[（(]\s*@[A-Za-z0-9._]+\s*[）)]\s*$/,"")
        .trim();

      const matched=await findGooglePlaceForShop(env,{
        name:cleanName,
        area:s.area||"熊本"
      });

      if(!matched?.ok){
        return json({
          ok:false,
          configured:!!matched?.configured,
          error:matched?.error||"GOOGLE_PLACE_LOOKUP_FAILED"
        },{status:matched?.configured===false?503:502});
      }

      if(!matched?.matched || !matched?.place?.id){
        return json({
          ok:true,
          configured:true,
          matched:false,
          rating:null,
          user_rating_count:0,
          reviews:[]
        });
      }

      const details=await googlePlaceReviewDetails(env,matched.place.id);
      if(!details.ok){
        return json({
          ok:false,
          configured:!!details.configured,
          error:details.error||"GOOGLE_REVIEW_FETCH_FAILED"
        },{status:details.configured===false?503:502});
      }

      const p=details.place||{};
      const reviews=(Array.isArray(p.reviews)?p.reviews:[])
        .slice(0,3)
        .map(publicGoogleReview);

      return json({
        ok:true,
        configured:true,
        matched:true,
        source:"Google Maps",
        place_id:String(p.id||matched.place.id||""),
        place_name:String(p?.displayName?.text||cleanName),
        rating:Number.isFinite(Number(p.rating))?Number(p.rating):null,
        user_rating_count:Number(p.userRatingCount||0),
        google_maps_uri:String(
          p?.googleMapsLinks?.reviewsUri||
          p?.googleMapsLinks?.placeUri||
          p?.googleMapsUri||
          ""
        ),
        reviews
      },{
        headers:{
          "Cache-Control":"public, max-age=300, stale-while-revalidate=1800"
        }
      });
    }


    // -------------------- FREE MEMBER API v1.90 --------------------
    if(url.pathname==="/api/member/register" && request.method==="POST"){
      try{
        await ensureKbnMemberSchema(env);
        let x={};try{x=await request.json()}catch{}
      const email=kbnMemberEmail(x.email);
      const displayName=kbnMemberName(x.display_name);
      const password=String(x.password||"");
      const emailNotifications=x.email_notifications===false?0:1;

      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){
        return kbnMemberJson({ok:false,error:"INVALID_EMAIL"},400);
      }
      if(password.length<8||password.length>128){
        return kbnMemberJson({ok:false,error:"PASSWORD_MIN_8"},400);
      }

      const exists=await env.DB.prepare("SELECT id FROM members WHERE email=? LIMIT 1").bind(email).first();
      if(exists)return kbnMemberJson({ok:false,error:"EMAIL_ALREADY_REGISTERED"},409);

      const ph=await kbnHashPassword(password);
      const unsub=kbnRandomToken(24);
      const r=await env.DB.prepare(`
        INSERT INTO members(
          email,display_name,password_hash,password_salt,
          email_notifications,unsubscribe_token,status
        ) VALUES(?,?,?,?,?,?,'active')
      `).bind(email,displayName,ph.hash,ph.salt,emailNotifications,unsub).run();

      const memberId=Number(r.meta?.last_row_id||0);
      const token=await kbnCreateMemberSession(env,memberId);
      const member=await env.DB.prepare(`
        SELECT id,email,display_name,email_notifications,unsubscribe_token
        FROM members WHERE id=? LIMIT 1
      `).bind(memberId).first();

      // 登録完了レスポンスを最優先。Welcomeメールは登録処理をブロックしない。
      // 新着BARメール配信は予約メンテナンス時に別処理で送信します。
        return kbnMemberJson({
          ok:true,
          member:kbnPublicMember({
            ...member,
            email_notifications:Number(member.email_notifications||0)===1
          })
        },201,{"Set-Cookie":kbnSessionCookie(token)});
      }catch(e){
        console.error("member register failed",e);
        return kbnMemberJson({
          ok:false,
          error:"REGISTER_FAILED",
          detail:String(e?.message||e||"UNKNOWN")
        },500);
      }
    }

    if(url.pathname==="/api/member/login" && request.method==="POST"){
      await ensureKbnMemberSchema(env);
      let x={};try{x=await request.json()}catch{}
      const email=kbnMemberEmail(x.email);
      const password=String(x.password||"");
      const row=await env.DB.prepare(`
        SELECT id,email,display_name,password_hash,password_salt,email_notifications,status
        FROM members WHERE email=? LIMIT 1
      `).bind(email).first();

      if(!row||String(row.status)!=="active"){
        return kbnMemberJson({ok:false,error:"LOGIN_FAILED"},401);
      }
      const ph=await kbnHashPassword(password,row.password_salt);
      if(!kbnSafeEqual(ph.hash,row.password_hash)){
        return kbnMemberJson({ok:false,error:"LOGIN_FAILED"},401);
      }

      const token=await kbnCreateMemberSession(env,Number(row.id));
      await env.DB.prepare("UPDATE members SET last_login_at=CURRENT_TIMESTAMP WHERE id=?").bind(row.id).run();
      return kbnMemberJson({
        ok:true,
        member:kbnPublicMember({
          ...row,
          email_notifications:Number(row.email_notifications||0)===1
        })
      },200,{"Set-Cookie":kbnSessionCookie(token)});
    }

    if(url.pathname==="/api/member/logout" && request.method==="POST"){
      await ensureKbnMemberSchema(env);
      const token=kbnCookieValue(request,KBN_MEMBER_COOKIE);
      if(token)await env.DB.prepare("DELETE FROM member_sessions WHERE token=?").bind(token).run();
      return kbnMemberJson({ok:true},200,{"Set-Cookie":kbnClearSessionCookie()});
    }

    if(url.pathname==="/api/member/me" && request.method==="GET"){
      const member=await kbnCurrentMember(env,request);
      return kbnMemberJson({ok:true,member:kbnPublicMember(member)});
    }

    if(url.pathname==="/api/member/preferences" && request.method==="PUT"){
      const member=await kbnCurrentMember(env,request);
      if(!member)return kbnMemberJson({ok:false,error:"LOGIN_REQUIRED"},401);
      let x={};try{x=await request.json()}catch{}
      const value=x.email_notifications===true?1:0;
      await env.DB.prepare(`
        UPDATE members SET email_notifications=?,updated_at=CURRENT_TIMESTAMP WHERE id=?
      `).bind(value,member.id).run();
      return kbnMemberJson({ok:true,email_notifications:!!value});
    }

    if(url.pathname==="/api/member/favorites" && request.method==="GET"){
      const member=await kbnCurrentMember(env,request);
      if(!member)return kbnMemberJson({ok:false,error:"LOGIN_REQUIRED"},401);
      const r=await env.DB.prepare(`
        SELECT s.id,s.slug,s.name,s.area,s.genre,s.image_url,f.created_at
        FROM member_favorites f
        JOIN shops s ON s.id=f.shop_id
        WHERE f.member_id=? AND s.is_published=1
        ORDER BY f.created_at DESC
      `).bind(member.id).all();
      return kbnMemberJson({ok:true,favorites:r.results||[]});
    }

    const favoriteMatch=url.pathname.match(/^\/api\/member\/favorites\/(\d+)$/);
    if(favoriteMatch && request.method==="POST"){
      const member=await kbnCurrentMember(env,request);
      if(!member)return kbnMemberJson({ok:false,error:"LOGIN_REQUIRED"},401);
      const shopId=Number(favoriteMatch[1]);
      const shopRow=await env.DB.prepare("SELECT id FROM shops WHERE id=? AND is_published=1").bind(shopId).first();
      if(!shopRow)return kbnMemberJson({ok:false,error:"SHOP_NOT_FOUND"},404);
      await env.DB.prepare(`
        INSERT OR IGNORE INTO member_favorites(member_id,shop_id) VALUES(?,?)
      `).bind(member.id,shopId).run();
      return kbnMemberJson({ok:true,favorited:true});
    }

    if(favoriteMatch && request.method==="DELETE"){
      const member=await kbnCurrentMember(env,request);
      if(!member)return kbnMemberJson({ok:false,error:"LOGIN_REQUIRED"},401);
      const shopId=Number(favoriteMatch[1]);
      await env.DB.prepare(`
        DELETE FROM member_favorites WHERE member_id=? AND shop_id=?
      `).bind(member.id,shopId).run();
      return kbnMemberJson({ok:true,favorited:false});
    }

    if(url.pathname==="/api/member/unsubscribe" && request.method==="GET"){
      await ensureKbnMemberSchema(env);
      const token=String(url.searchParams.get("token")||"").trim();
      if(token){
        await env.DB.prepare(`
          UPDATE members SET email_notifications=0,updated_at=CURRENT_TIMESTAMP
          WHERE unsubscribe_token=?
        `).bind(token).run();
      }
      return new Response(`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>配信停止｜BARナビ</title><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#080b10;color:#fff;padding:40px 20px"><main style="max-width:520px;margin:auto"><h1>新着メールを配信停止しました</h1><p style="color:#b7c0ca">いつでもマイページから再開できます。</p><a href="/member.html" style="color:#efc45a">マイページへ</a></main></body></html>`,{
        headers:{"content-type":"text/html; charset=utf-8"}
      });
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
      await ensureSubmissionJobColumns(env);
      await env.DB.prepare(`
        INSERT INTO submissions (
          shop_name, contact_name, email, phone, address, hours, holiday, instagram,
          genre, features, description, budget_min, budget_max, seats, wants_job, note,
          job_title,job_employment_type,job_salary,job_hours,job_description,job_contact
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).bind(
        t(x.shop_name,150),t(x.contact_name,150),t(x.email,200),t(x.phone,80),
        t(x.address,300),t(x.hours,150),t(x.holiday,120),t(x.instagram,500),
        t(x.genre,120),t(x.features,1000),t(x.description,5000),ni(x.budget_min),
        ni(x.budget_max),ni(x.seats),b(x.wants_job),t(x.note,3000),
        t(x.job_title,180),t(x.job_employment_type,120),t(x.job_salary,180),
        t(x.job_hours,180),t(x.job_description,5000),t(x.job_contact,500)
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

      // v2.37: 店舗情報変更も自動反映せず、必ず管理者の承認待ちにする
      if(requestType==="profile"){
        const p=x.payload||{};

        const current=await env.DB.prepare("SELECT * FROM shops WHERE id=?").bind(shop.id).first();
        if(!current)return json({ok:false,error:"SHOP_NOT_FOUND"},{status:404});

        const r=await env.DB.prepare(`
          INSERT INTO owner_requests (shop_id,request_type,payload,status)
          VALUES (?,?,?,'pending')
        `).bind(shop.id,requestType,payload).run();

        if(ctx?.waitUntil){
          ctx.waitUntil(
            notifyOwnerRequest(env,current,requestType,p,false)
              .catch(e=>console.error("owner profile notification failed",e))
          );
        }

        return json({
          ok:true,
          id:r.meta?.last_row_id,
          auto_applied:false,
          status:"pending"
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






      // ---------- Structured data validator v270 ----------
      if(url.pathname==="/api/admin/structured-data-check" && request.method==="GET"){
        const slug=String(url.searchParams.get("slug")||"").trim();
        if(!slug)return json({ok:false,error:"SLUG_REQUIRED"},{status:400});
        const shop=await env.DB.prepare(`SELECT * FROM shops WHERE slug=? AND COALESCE(is_published,1)=1 LIMIT 1`).bind(slug).first();
        if(!shop)return json({ok:false,error:"SHOP_NOT_FOUND"},{status:404});
        const audit=kbnStructuredDataAudit(shop,url.origin);
        return json({
          ok:true,
          shop:{id:shop.id,slug:shop.slug,name:kbnCleanShopName(shop.name),area:shop.area,genre:shop.genre},
          score:audit.score,
          errors:audit.errors,
          warnings:audit.warnings,
          passed:audit.passed,
          canonical:audit.canonical,
          jsonld:audit.node
        },{headers:{"Cache-Control":"no-store"}});
      }

      // ---------- SEO / index readiness monitor v3.12 ----------
      if(url.pathname==="/api/admin/seo-monitor" && request.method==="GET"){
        const scoreExpr=KBN_SEO_SCORE_SQL_V312;
        const summary=await env.DB.prepare(`
          WITH published AS (
            SELECT s.*, (${scoreExpr}) AS seo_score
            FROM shops s
            WHERE COALESCE(s.is_published,1)=1
          ), slug_dupes AS (
            SELECT slug FROM published
            WHERE TRIM(COALESCE(slug,''))!=''
            GROUP BY slug HAVING COUNT(*)>1
          )
          SELECT
            COUNT(*) AS published,
            SUM(CASE WHEN TRIM(COALESCE(slug,''))!='' THEN 1 ELSE 0 END) AS sitemap_urls,
            SUM(CASE WHEN LENGTH(TRIM(COALESCE(description,'')))<80 THEN 1 ELSE 0 END) AS missing_description,
            SUM(CASE WHEN LENGTH(TRIM(COALESCE(description,'')))>=160 THEN 1 ELSE 0 END) AS description_good,
            SUM(CASE WHEN LENGTH(TRIM(COALESCE(description,'')))>=80 AND LENGTH(TRIM(COALESCE(description,'')))<160 THEN 1 ELSE 0 END) AS description_mid,
            SUM(CASE WHEN LENGTH(TRIM(COALESCE(description,'')))<80 THEN 1 ELSE 0 END) AS description_low,
            SUM(CASE WHEN TRIM(COALESCE(address,''))='' THEN 1 ELSE 0 END) AS missing_address,
            SUM(CASE WHEN TRIM(COALESCE(hours,''))='' THEN 1 ELSE 0 END) AS missing_hours,
            SUM(CASE WHEN TRIM(COALESCE(genre,''))='' THEN 1 ELSE 0 END) AS missing_genre,
            SUM(CASE WHEN TRIM(COALESCE(image_url,''))='' AND TRIM(COALESCE(image_key,''))='' THEN 1 ELSE 0 END) AS missing_image,
            SUM(CASE WHEN TRIM(COALESCE(image_url,''))!='' OR TRIM(COALESCE(image_key,''))!='' THEN 1 ELSE 0 END) AS image_good,
            SUM(CASE WHEN TRIM(COALESCE(slug,''))='' OR slug IN (SELECT slug FROM slug_dupes) THEN 1 ELSE 0 END) AS url_risk,
            SUM(CASE WHEN seo_score>=90 THEN 1 ELSE 0 END) AS score_90_plus,
            SUM(CASE WHEN seo_score>=80 AND seo_score<90 THEN 1 ELSE 0 END) AS score_80s,
            SUM(CASE WHEN seo_score>=70 AND seo_score<80 THEN 1 ELSE 0 END) AS score_70s,
            SUM(CASE WHEN seo_score<70 THEN 1 ELSE 0 END) AS score_under70,
            ROUND(AVG(seo_score),1) AS avg_score,
            MIN(seo_score) AS min_score,
            MAX(seo_score) AS max_score
          FROM published
        `).first();

        const low=await env.DB.prepare(`
          SELECT s.id,s.slug,s.name,s.area,(${scoreExpr}) AS seo_score,
                 CASE WHEN TRIM(COALESCE(s.hours,''))='' THEN 1 ELSE 0 END AS miss_hours,
                 CASE WHEN TRIM(COALESCE(s.address,''))='' THEN 1 ELSE 0 END AS miss_address,
                 CASE WHEN LENGTH(TRIM(COALESCE(s.description,'')))<80 THEN 1 ELSE 0 END AS miss_description,
                 CASE WHEN TRIM(COALESCE(s.image_url,''))='' AND TRIM(COALESCE(s.image_key,''))='' THEN 1 ELSE 0 END AS miss_image
          FROM shops s
          WHERE COALESCE(s.is_published,1)=1
          ORDER BY (${scoreExpr}) ASC,s.id ASC
          LIMIT 8
        `).all();

        const published=Number(summary?.published||0);
        const good=Number(summary?.score_90_plus||0);
        return json({
          ok:true,
          summary:{
            published,
            sitemap_urls:Number(summary?.sitemap_urls||0),
            seo_good:good,
            needs_improvement:Math.max(0,published-good),
            url_risk:Number(summary?.url_risk||0),
            quality_percent:published?Math.round(good/published*100):0,
            average_score:Number(summary?.avg_score||0),
            min_score:Number(summary?.min_score||0),
            max_score:Number(summary?.max_score||0),
            score_90_plus:good,
            score_80s:Number(summary?.score_80s||0),
            score_70s:Number(summary?.score_70s||0),
            score_under70:Number(summary?.score_under70||0)
          },
          missing:{
            description:Number(summary?.missing_description||0),
            description_good:Number(summary?.description_good||0),
            description_mid:Number(summary?.description_mid||0),
            description_low:Number(summary?.description_low||0),
            address:Number(summary?.missing_address||0),
            hours:Number(summary?.missing_hours||0),
            genre:Number(summary?.missing_genre||0),
            image:Number(summary?.missing_image||0),
            image_good:Number(summary?.image_good||0)
          },
          lowest:(low.results||[]).map(x=>({
            id:Number(x.id||0),slug:x.slug||'',name:x.name||'',area:x.area||'',score:Number(x.seo_score||0),
            missing:[x.miss_hours?'営業時間':'',x.miss_address?'住所':'',x.miss_description?'説明文':'',x.miss_image?'画像':''].filter(Boolean)
          })),
          score_rule:"100点満点。90点以上をSEO良好として、通常メンテナンスでは低スコア店舗から最大20店舗を優先改善します。画像は店舗固有画像のみSEO評価し、画像なし店舗に偽の代替画像は付けません。",
          note:"Search Consoleの実インデックス数ではなく、全公開店舗のSEO準備度スコアです。"
        });
      }

      if(url.pathname==="/api/admin/seo-improve-low" && request.method==="POST"){
        const result=await refreshSeoPublishedV311(env,{limit:20,afterId:0});
        try{
          await createKbnAlert(env,{
            type:"seo_score_improve",
            title:"SEOスコア改善: 低スコア店舗",
            message:`${Number(result?.checked||0)}店舗を確認 / 更新${Array.isArray(result?.updated)?result.updated.length:0}件 / 100点満点の低スコア順で処理`
          });
        }catch{}
        return json({ok:true,...result});
      }

      // ---------- Free members dashboard v2.05 ----------
      if(url.pathname==="/api/admin/members" && request.method==="GET"){
        await ensureKbnMemberSchema(env);

        const summary=await env.DB.prepare(`
          SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active,
            SUM(CASE WHEN status='active' AND email_notifications=1 THEN 1 ELSE 0 END) AS notifications_on,
            SUM(CASE WHEN datetime(created_at)>=datetime('now','-7 days') THEN 1 ELSE 0 END) AS new_7d
          FROM members
        `).first();

        const favSummary=await env.DB.prepare(`
          SELECT COUNT(*) AS total_favorites
          FROM member_favorites
        `).first();

        const rows=await env.DB.prepare(`
          SELECT
            m.id,
            m.email,
            m.display_name,
            m.email_notifications,
            m.status,
            m.created_at,
            m.updated_at,
            m.last_login_at,
            COUNT(f.shop_id) AS favorite_count
          FROM members m
          LEFT JOIN member_favorites f ON f.member_id=m.id
          GROUP BY
            m.id,m.email,m.display_name,m.email_notifications,m.status,
            m.created_at,m.updated_at,m.last_login_at
          ORDER BY m.id DESC
          LIMIT 500
        `).all();

        return json({
          ok:true,
          summary:{
            total:Number(summary?.total||0),
            active:Number(summary?.active||0),
            notifications_on:Number(summary?.notifications_on||0),
            new_7d:Number(summary?.new_7d||0),
            total_favorites:Number(favSummary?.total_favorites||0)
          },
          members:(rows.results||[]).map(m=>({
            id:Number(m.id),
            email:String(m.email||""),
            display_name:String(m.display_name||""),
            email_notifications:Number(m.email_notifications||0)===1,
            status:String(m.status||"active"),
            created_at:m.created_at||"",
            updated_at:m.updated_at||"",
            last_login_at:m.last_login_at||"",
            favorite_count:Number(m.favorite_count||0)
          }))
        },{headers:{"Cache-Control":"no-store"}});
      }

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


      if(url.pathname==="/api/admin/auto-schedule" && request.method==="GET"){
        try{
          const schedule=await kbnGetRuntimeScheduleV230(env);
          let lastAutomaticRun=null;
          let maintenanceQueue=null;
          try{lastAutomaticRun=await kbnLastAutomaticRunV233(env)}catch(e){console.error("last automatic run read failed",e)}
          try{maintenanceQueue=await kbnMaintenanceQueueStatusV257(env)}catch(e){console.error("maintenance queue status read failed",e)}
          return json({
            ok:true,
            timezone:"Asia/Tokyo",
            ...schedule,
            last_automatic_run:lastAutomaticRun||null,
            maintenance_queue:maintenanceQueue||null
          });
        }catch(e){
          return json({ok:false,error:"AUTO_SCHEDULE_READ_FAILED",message:String(e?.message||e).slice(0,500)},{status:e?.status||500});
        }
      }

      if(url.pathname==="/api/admin/auto-schedule" && request.method==="PUT"){
        let x={};
        try{x=await request.json()}catch{return json({ok:false,error:"INVALID_JSON"},{status:400})}
        try{
          const schedule=await kbnSaveRuntimeScheduleV230(env,x);
          const fixedCron=await kbnEnsureMinuteCronPermanentV230(env);
          return json({
            ok:true,
            ...schedule,
            fixed_cron:fixedCron,
            immediate:true,
            message:"予約時間を保存しました。次回からこの時間に自動実行します。"
          });
        }catch(e){
          return json({ok:false,error:"AUTO_SCHEDULE_UPDATE_FAILED",message:String(e?.message||e).slice(0,500)},{status:e?.status||500});
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
            exists:true,
            path,
            sha:d.sha,
            size:d.size,
            content:kbnBase64ToUtf8(d.content||""),
            html_url:d.html_url||"",
            ref
          });
        }catch(e){
          if(Number(e?.status)===404){
            return json({
              ok:true,
              exists:false,
              path,
              sha:"",
              size:0,
              content:"",
              html_url:"",
              ref
            });
          }
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
        if(content.length>900000){
          return json({ok:false,error:"FILE_TOO_LARGE"},{status:413});
        }

        try{
          const body={
            message,
            content:kbnUtf8ToBase64(content),
            branch:c.branch
          };
          if(sha)body.sha=sha;

          const result=await kbnGithubApi(
            env,
            `/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/contents/${encodeURIComponent(path)}`,
            {
              method:"PUT",
              headers:{"content-type":"application/json"},
              body:JSON.stringify(body)
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
            force:!!x.force,
            missingOnly:!!x.missing_only
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
        const max=Math.max(1,Math.min(Number(x.max_listings)||10,50));
        const pairs=Math.max(1,Math.min(Number(x.pair_limit)||15,40));
        const perPair=Math.max(1,Math.min(Number(x.per_pair_limit)||2,4));

        try{
          const result=await autoDiscover(env,request,max,pairs,perPair);
          if(result?.created?.length){
            ctx.waitUntil(notifyCreatedShops(env,result.created,"自動開拓").catch(e=>console.error("new shop alert failed",e)));
          }
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


      if(url.pathname==="/api/admin/leads/refresh-images" && request.method==="POST"){
        let x={};try{x=await request.json()}catch{}
        try{
          const result=await refreshMissingShopImages(env,{limit:Math.max(1,Math.min(Number(x.limit)||20,30)),afterId:Math.max(0,Number(x.after_id)||0)});
          return json(result,{headers:{"Cache-Control":"no-store"}});
        }catch(e){
          return json({ok:false,error:"REFRESH_IMAGES_FAILED",message:String(e?.message||e).slice(0,500)},{status:500});
        }
      }

      if(url.pathname==="/api/admin/leads/refresh-missing" && request.method==="POST"){
        try{
          const result=await runMaintenanceBatchV242(env,"missing",{limit:20});
          return json(result,{headers:{"Cache-Control":"no-store"}});
        }catch(e){
          return json({ok:false,error:"REFRESH_MISSING_FAILED",message:String(e?.message||e).slice(0,500)},{status:500});
        }
      }

      if(url.pathname==="/api/admin/leads/check-closed" && request.method==="POST"){
        try{
          const result=await runMaintenanceBatchV242(env,"closed",{limit:20});
          return json(result,{headers:{"Cache-Control":"no-store"}});
        }catch(e){
          return json({ok:false,error:"CLOSED_CHECK_FAILED",message:String(e?.message||e).slice(0,500)},{status:500});
        }
      }

      if(url.pathname==="/api/admin/alerts" && request.method==="GET"){
        await ensureKbnAlertsTable(env);
        const r=await env.DB.prepare(`
          SELECT id,alert_type,title,message,shop_id,is_read,created_at
          FROM kbn_admin_alerts
          ORDER BY id DESC LIMIT 50
        `).all();
        const unread=(r.results||[]).filter(x=>!Number(x.is_read)).length;
        return json({ok:true,alerts:r.results||[],unread});
      }

      const alertReadRoute=url.pathname.match(/^\/api\/admin\/alerts\/(\d+)\/read$/);
      if(alertReadRoute && request.method==="POST"){
        await ensureKbnAlertsTable(env);
        await env.DB.prepare("UPDATE kbn_admin_alerts SET is_read=1 WHERE id=?").bind(Number(alertReadRoute[1])).run();
        return json({ok:true});
      }

      const maintenanceActionRoute=url.pathname.match(/^\/api\/admin\/shops\/(\d+)\/maintenance-action$/);
      if(maintenanceActionRoute && request.method==="POST"){
        let x={};try{x=await request.json()}catch{}
        try{
          const shop=await setShopMaintenanceAction(
            env,
            Number(maintenanceActionRoute[1]),
            String(x.action||"")
          );
          if(!shop)return json({ok:false,error:"SHOP_NOT_FOUND"},{status:404});

          await ensureKbnAlertsTable(env);
          await env.DB.prepare(`
            UPDATE kbn_admin_alerts SET is_read=1
            WHERE shop_id=? AND alert_type='closed_shop'
          `).bind(Number(shop.id)).run();

          const labels={
            operational:"営業中として継続",
            temporary_closed:"一時休業として確認",
            unpublish:"掲載取り消し"
          };
          await createKbnAlert(env,{
            type:"maintenance_action",
            title:`店舗対応: ${shop.name}`,
            message:`${labels[String(x.action||"")]||"状態変更"}を実行しました。`,
            shopId:shop.id
          });

          return json({ok:true,shop});
        }catch(e){
          return json({
            ok:false,error:"MAINTENANCE_ACTION_FAILED",
            message:String(e?.message||e).slice(0,500)
          },{status:400});
        }
      }

      if(url.pathname==="/api/admin/leads/refresh-instagram" && request.method==="POST"){
        try{
          const result=await runMaintenanceBatchV242(env,"instagram",{limit:20});
          return json(result,{headers:{"Cache-Control":"no-store"}});
        }catch(e){
          return json({ok:false,error:"REFRESH_INSTAGRAM_FAILED",message:String(e?.message||e).slice(0,500)},{status:500});
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
          public_url:`${origin}/shop?slug=${encodeURIComponent(slug)}`
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

      if(url.pathname==="/api/admin/leads/auto-listed" && request.method==="GET"){
        const limit=Math.max(1,Math.min(Number(url.searchParams.get("limit")||200),500));
        const offset=Math.max(0,Number(url.searchParams.get("offset")||0));

        const totalRow=await env.DB.prepare(`
          SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN is_published=1 THEN 1 ELSE 0 END) AS live
          FROM shops
          WHERE COALESCE(listing_status,'published')='provisional'
        `).first();

        const r=await env.DB.prepare(`
          SELECT id,slug,name,area,genre,address,instagram,is_published,listing_status,published_at,updated_at
          FROM shops
          WHERE COALESCE(listing_status,'published')='provisional'
          ORDER BY id DESC
          LIMIT ? OFFSET ?
        `).bind(limit,offset).all();

        return json({
          ok:true,
          shops:r.results||[],
          total:Number(totalRow?.total||0),
          live:Number(totalRow?.live||0),
          cancelled:Number(totalRow?.total||0)-Number(totalRow?.live||0),
          limit,
          offset
        });
      }

      const autoListedDelete=url.pathname.match(/^\/api\/admin\/leads\/auto-listed\/(\d+)$/);
      if(autoListedDelete && request.method==="DELETE"){
        const id=Number(autoListedDelete[1]);
        const shop=await env.DB.prepare("SELECT * FROM shops WHERE id=? LIMIT 1").bind(id).first();
        if(!shop)return json({ok:false,error:"NOT_FOUND"},{status:404});
        if(normalizeListingStatus(shop.listing_status)!=="provisional"){
          return json({ok:false,error:"NOT_PROVISIONAL_LISTING"},{status:400});
        }
        await archiveDeletedAutoListing(env,shop);
        try{await env.DB.prepare("DELETE FROM jobs WHERE shop_id=?").bind(id).run();}catch{}
        try{await env.DB.prepare("DELETE FROM member_favorites WHERE shop_id=?").bind(id).run();}catch{}
        try{await env.DB.prepare("DELETE FROM shop_images WHERE shop_id=?").bind(id).run();}catch{}
        try{await env.DB.prepare("DELETE FROM shop_views WHERE shop_id=?").bind(id).run();}catch{}
        await env.DB.prepare("DELETE FROM shops WHERE id=?").bind(id).run();
        return json({ok:true,id,name:shop.name||"",deleted:true});
      }

      const autoListedAction=url.pathname.match(/^\/api\/admin\/leads\/auto-listed\/(\d+)\/(unpublish|restore)$/);
      if(autoListedAction && request.method==="POST"){
        const id=Number(autoListedAction[1]);
        const action=autoListedAction[2];
        const shop=await env.DB.prepare(`
          SELECT id,name,listing_status,is_published FROM shops WHERE id=? LIMIT 1
        `).bind(id).first();
        if(!shop)return json({ok:false,error:"NOT_FOUND"},{status:404});
        if(normalizeListingStatus(shop.listing_status)!=="provisional"){
          return json({ok:false,error:"NOT_PROVISIONAL_LISTING"},{status:400});
        }
        const published=action==="restore"?1:0;
        await env.DB.prepare(`
          UPDATE shops SET is_published=?,updated_at=CURRENT_TIMESTAMP WHERE id=?
        `).bind(published,id).run();
        return json({ok:true,shop_id:id,is_published:published,action});
      }


      // v2.59/v2.67: 掲載済み店舗から「対象外の可能性が高い店舗」を抽出。
      if(url.pathname==="/api/admin/shops/exclusion-candidates" && request.method==="GET"){
        const scan=await kbnScanExclusionCandidatesV267(env);
        return json({
          ok:true,
          total:Number(scan.checked||0),
          ignored_count:Number(scan.ignored_count||0),
          candidate_count:Number(scan.candidate_count||0),
          candidates:Array.isArray(scan.candidates)?scan.candidates:[]
        });
      }

      // v2.59: 対象外候補だけを選択削除 / 一括削除。
      // 安全のため、送られたIDをサーバー側でも再判定し、候補外は削除しない。

      // v2.65: 正しい店舗は対象外候補から永続的に除外。
      if((url.pathname==="/api/admin/shops/exclusion-candidates/ignore" || url.pathname==="/api/admin/exclusion-ignore") && request.method==="POST"){
        let body;
        try{body=await request.json()}catch{return json({ok:false,error:"INVALID_JSON"},{status:400})}

        const shopId=Number(body?.shop_id||0);
        if(!Number.isInteger(shopId)||shopId<=0){
          return json({ok:false,error:"INVALID_SHOP_ID"},{status:400});
        }

        const shop=await env.DB.prepare(`
          SELECT id,name FROM shops WHERE id=? LIMIT 1
        `).bind(shopId).first();

        if(!shop){
          return json({ok:false,error:"SHOP_NOT_FOUND"},{status:404});
        }

        await ensureKbnExclusionCandidateIgnoresV265(env);
        await env.DB.prepare(`
          INSERT INTO kbn_exclusion_candidate_ignores(shop_id,note,created_at,updated_at)
          VALUES(?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
          ON CONFLICT(shop_id) DO UPDATE SET
            note=excluded.note,
            updated_at=CURRENT_TIMESTAMP
        `).bind(
          shopId,
          t(body?.note||"管理者が正しい店舗として対象外候補から除外",500)
        ).run();

        return json({
          ok:true,
          shop_id:shopId,
          name:shop.name||""
        });
      }

      if(url.pathname==="/api/admin/shops/exclusion-candidates/bulk-delete" && request.method==="POST"){
        let body;
        try{body=await request.json()}catch{return json({ok:false,error:"INVALID_JSON"},{status:400})}

        // v2.62: 1リクエスト最大10店舗に制限。
        // 管理画面側が自動で小分け送信することでSafari/CloudflareのLoad failedを防ぐ。
        const ids=[...new Set(
          (Array.isArray(body?.ids)?body.ids:[])
            .map(Number)
            .filter(x=>Number.isInteger(x)&&x>0)
        )].slice(0,10);

        if(!ids.length)return json({ok:false,error:"NO_IDS"},{status:400});

        const deleted=[];
        const skipped=[];
        const failed=[];

        // 関連テーブルの存在確認はリクエスト内で1回だけ。
        const existingTables=new Set();
        try{
          const tr=await env.DB.prepare(`
            SELECT name FROM sqlite_master
            WHERE type='table'
            AND name IN ('shop_images','shop_analytics','jobs','owner_requests','member_favorites','shop_views','kbn_exclusion_candidate_ignores')
          `).all();
          for(const row of (tr.results||[]))existingTables.add(String(row.name||""));
        }catch(e){
          console.error("related tables lookup failed",e);
        }

        for(const id of ids){
          try{
            const shop=await env.DB.prepare("SELECT * FROM shops WHERE id=? LIMIT 1").bind(id).first();
            if(!shop){
              skipped.push({id,reason:"NOT_FOUND"});
              continue;
            }

            const check=kbnExclusionCandidateV259(shop);
            if(!check.candidate){
              skipped.push({id,name:shop.name||"",reason:"NO_LONGER_CANDIDATE"});
              continue;
            }

            // 削除履歴へ保存。これにより自動開拓での再掲載も防ぐ。
            try{await archiveDeletedAutoListing(env,shop)}catch(e){
              console.error("archive excluded shop failed",id,e);
            }

            // 1店舗分をまとめてD1 batchで削除。
            const stmts=[];
            if(existingTables.has("shop_images"))stmts.push(env.DB.prepare("DELETE FROM shop_images WHERE shop_id=?").bind(id));
            if(existingTables.has("shop_analytics"))stmts.push(env.DB.prepare("DELETE FROM shop_analytics WHERE shop_id=?").bind(id));
            if(existingTables.has("jobs"))stmts.push(env.DB.prepare("DELETE FROM jobs WHERE shop_id=?").bind(id));
            if(existingTables.has("owner_requests"))stmts.push(env.DB.prepare("DELETE FROM owner_requests WHERE shop_id=?").bind(id));
            if(existingTables.has("member_favorites"))stmts.push(env.DB.prepare("DELETE FROM member_favorites WHERE shop_id=?").bind(id));
            if(existingTables.has("shop_views"))stmts.push(env.DB.prepare("DELETE FROM shop_views WHERE shop_id=?").bind(id));
            if(existingTables.has("kbn_exclusion_candidate_ignores")){
              stmts.push(env.DB.prepare("DELETE FROM kbn_exclusion_candidate_ignores WHERE shop_id=?").bind(id));
            }
            stmts.push(env.DB.prepare("DELETE FROM shops WHERE id=?").bind(id));

            if(typeof env.DB.batch==="function"){
              await env.DB.batch(stmts);
            }else{
              for(const stmt of stmts)await stmt.run();
            }

            deleted.push({
              ok:true,
              id:Number(id),
              name:shop.name||"",
              reasons:check.reasons||[]
            });
          }catch(e){
            console.error("excluded shop delete failed",id,e);
            failed.push({id,error:String(e?.message||e)});
          }
        }

        return json({
          ok:failed.length===0,
          requested:ids.length,
          deleted_count:deleted.length,
          skipped_count:skipped.length,
          failed_count:failed.length,
          deleted,
          skipped,
          failed
        },{status:failed.length?207:200});
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
          const shop=await env.DB.prepare("SELECT * FROM shops WHERE id=?").bind(id).first();
          if(!shop)return json({ok:false,error:"NOT_FOUND"},{status:404});
          if(normalizeListingStatus(shop.listing_status)==="provisional"){
            await archiveDeletedAutoListing(env,shop);
          }

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


      const orProfile=url.pathname.match(/^\/api\/admin\/owner-requests\/(\d+)\/apply-profile$/);
      if(orProfile && request.method==="POST"){
        const id=Number(orProfile[1]);

        const req=await env.DB.prepare(`
          SELECT owner_requests.*,shops.id AS target_shop_id
          FROM owner_requests
          JOIN shops ON shops.id=owner_requests.shop_id
          WHERE owner_requests.id=?
        `).bind(id).first();

        if(!req)return json({ok:false,error:"NOT_FOUND"},{status:404});
        if(req.request_type!=="profile")return json({ok:false,error:"NOT_PROFILE_REQUEST"},{status:400});
        if(req.status!=="pending")return json({ok:false,error:"REQUEST_ALREADY_REVIEWED"},{status:409});

        let p={};
        try{p=JSON.parse(req.payload||"{}")}catch{
          return json({ok:false,error:"INVALID_PAYLOAD"},{status:400});
        }

        const current=await env.DB.prepare("SELECT * FROM shops WHERE id=?")
          .bind(req.target_shop_id).first();
        if(!current)return json({ok:false,error:"SHOP_NOT_FOUND"},{status:404});

        // 申請された項目だけを反映。未申請項目は現在値を維持。
        const merged={
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

        await env.DB.batch([
          env.DB.prepare(`
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
            req.target_shop_id
          ),
          env.DB.prepare(`
            UPDATE owner_requests
            SET status='reviewed',reviewed_at=CURRENT_TIMESTAMP
            WHERE id=? AND status='pending'
          `).bind(id)
        ]);

        return json({
          ok:true,
          applied:true,
          shop_id:req.target_shop_id,
          status:"reviewed"
        });
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


      if(url.pathname==="/api/admin/jobs/approved-submission-candidates" && request.method==="GET"){
        await ensureSubmissionJobColumns(env);
        const r=await env.DB.prepare(`
          SELECT * FROM submissions
          WHERE status='approved'
          ORDER BY id DESC
          LIMIT 300
        `).all();

        const candidates=[];
        for(const sub of (r.results||[])){
          try{
            if(!kbnJobIntentFromSubmission(sub))continue;

            const duplicate=await findSubmissionDuplicate(env,sub);
            if(!duplicate?.shop_id)continue;

            const extracted=kbnExtractJobData(sub);
            const existing=await env.DB.prepare(`
              SELECT id,title,is_published
              FROM jobs
              WHERE shop_id=? AND title=?
              ORDER BY id DESC LIMIT 1
            `).bind(Number(duplicate.shop_id),extracted.title).first();

            candidates.push({
              submission_id:Number(sub.id),
              shop_id:Number(duplicate.shop_id),
              shop_name:duplicate.name||sub.shop_name||"",
              submission_shop_name:sub.shop_name||"",
              contact_name:sub.contact_name||"",
              reviewed_at:sub.reviewed_at||"",
              title:extracted.title,
              employment_type:extracted.employment,
              salary:extracted.salary,
              hours:extracted.hours,
              description:extracted.description,
              contact:extracted.contact,
              source_note:sub.note||"",
              source_description:sub.description||"",
              source_features:sub.features||"",
              wants_job:Number(sub.wants_job||0)===1,
              auto_detected:Number(sub.wants_job||0)!==1,
              existing_job_id:existing?.id?Number(existing.id):null,
              existing_job_published:existing?.id?Number(existing.is_published||0):0,
              match_score:Number(duplicate.score||0),
              match_reasons:Array.isArray(duplicate.reasons)?duplicate.reasons:[]
            });
          }catch(e){
            console.error("approved submission job candidate failed",sub?.id,e);
          }
        }

        return json({ok:true,candidates,count:candidates.length},{
          headers:{"Cache-Control":"no-store"}
        });
      }

      const approvedJobPublish=url.pathname.match(/^\/api\/admin\/jobs\/approved-submissions\/(\d+)\/publish$/);
      if(approvedJobPublish && request.method==="POST"){
        await ensureSubmissionJobColumns(env);
        const submissionId=Number(approvedJobPublish[1]);

        const sub=await env.DB.prepare(`
          SELECT * FROM submissions
          WHERE id=? AND status='approved'
          LIMIT 1
        `).bind(submissionId).first();

        if(!sub)return json({ok:false,error:"APPROVED_SUBMISSION_NOT_FOUND"},{status:404});
        if(!kbnJobIntentFromSubmission(sub)){
          return json({ok:false,error:"NO_JOB_INFORMATION_DETECTED"},{status:400});
        }

        const duplicate=await findSubmissionDuplicate(env,sub);
        if(!duplicate?.shop_id){
          return json({ok:false,error:"MATCHING_SHOP_NOT_FOUND"},{status:404});
        }

        const job=await publishJobFromSubmission(env,sub,Number(duplicate.shop_id));
        return json({
          ok:true,
          submission_id:submissionId,
          shop_id:Number(duplicate.shop_id),
          shop_name:duplicate.name||sub.shop_name||"",
          job
        });
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
      if(jm && request.method==="DELETE"){
        const id=Number(jm[1]);
        const existing=await env.DB.prepare("SELECT id,title FROM jobs WHERE id=?").bind(id).first();
        if(!existing)return json({ok:false,error:"JOB_NOT_FOUND"},{status:404});

        await env.DB.prepare("DELETE FROM jobs WHERE id=?").bind(id).run();
        return json({ok:true,id,title:existing.title||""});
      }
      if(jm && request.method==="PUT"){
        const id=Number(jm[1]); let x;try{x=await request.json()}catch{return json({ok:false,error:"INVALID_JSON"},{status:400})}
        await env.DB.prepare(`
          UPDATE jobs SET shop_id=?,title=?,employment_type=?,salary=?,hours=?,description=?,contact=?,
          is_published=?,sort_order=?,updated_at=CURRENT_TIMESTAMP WHERE id=?
        `).bind(ni(x.shop_id),t(x.title,180),t(x.employment_type,120),t(x.salary,180),t(x.hours,180),t(x.description,5000),t(x.contact,500),x.is_published===false?0:1,ni(x.sort_order)??100,id).run();
        return json({ok:true});
      }

      if(url.pathname==="/api/admin/submissions" && request.method==="GET"){
        await ensureSubmissionJobColumns(env);
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
        await ensureSubmissionJobColumns(env);
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

          const job=await publishJobFromSubmission(env,sub,Number(merged.id));

          return json({
            ok:true,
            shop_id:Number(merged.id),
            merged:true,
            job,
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

          const job=await publishJobFromSubmission(env,sub,Number(merged.id));

          return json({
            ok:true,
            shop_id:Number(merged.id),
            merged:true,
            auto_merged:true,
            job,
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

        const shopId=Number(r.meta?.last_row_id||0);
        const job=await publishJobFromSubmission(env,sub,shopId);

        return json({ok:true,shop_id:shopId,merged:false,job});
      }
      const rp=url.pathname.match(/^\/api\/admin\/submissions\/(\d+)\/reject$/);
      if(rp && request.method==="POST"){
        await env.DB.prepare("UPDATE submissions SET status='rejected',reviewed_at=CURRENT_TIMESTAMP WHERE id=?").bind(Number(rp[1])).run();
        return json({ok:true});
      }

      return json({ok:false,error:"ADMIN_ROUTE_NOT_FOUND"},{status:404});
    }

    // v2.97 LCP phase 2: render hero stats into the first HTML response.
    // This avoids a late above-the-fold repaint after the stats API returns, which can
    // move the Lighthouse LCP timestamp several seconds even when FCP is already fast.
    if(request.method==="GET" && url.pathname==="/" && env.DB){
      try{
        const [assetResponse,row]=await Promise.all([
          env.ASSETS.fetch(request),
          env.DB.prepare(`SELECT COUNT(*) AS shop_count, COUNT(DISTINCT NULLIF(TRIM(area),'')) AS area_count FROM shops WHERE is_published=1`).first()
        ]);
        if(assetResponse.ok){
          let html=await assetResponse.text();
          const shopCount=Number(row?.shop_count||0);
          const areaCount=Number(row?.area_count||0);
          html=html
            .replace('<body class="public-v109">','<body class="public-v109" data-kbn-ssr-stats="1">')
            .replace(/<strong id="heroTotalShopCount">[\s\S]*?<\/strong>/,'<strong id="heroTotalShopCount">'+shopCount+'<span class="public-hero-unit-v211">店舗</span></strong>')
            .replace(/<strong id="heroAreaCount">[\s\S]*?<\/strong>/,'<strong id="heroAreaCount">'+areaCount+'<span class="public-hero-unit-v211">地域</span></strong>')
            .replace(/<span id="publicNoticeCountText">[\s\S]*?<\/span>/,'<span id="publicNoticeCountText">熊本県内のBARを '+shopCount+' 店舗掲載中</span>');
          const h=new Headers(assetResponse.headers);
          h.set('Content-Type','text/html; charset=utf-8');
          h.set('Cache-Control','public, max-age=30, stale-while-revalidate=120');
          h.set('X-KBN-LCP','phase2-ssr-stats');
          return kbnApplyPublicPerformanceHeaders(new Response(html,{status:assetResponse.status,statusText:assetResponse.statusText,headers:h}),url);
        }
      }catch(e){ console.error('homepage SSR stats failed',e); }
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

    // Public assets/pages: browser/CDN reuse is essential for repeat-view LCP and transfer size.
    // Admin remains explicitly no-store above.
    return kbnApplyPublicPerformanceHeaders(assetResponse,url);
  },

  async scheduled(event, env, ctx){
    const task=(async()=>{
      // v2.42: 前回の通常メンテナンスで予約された処理を1種類ずつ実行。
      // 1分ごとに別Worker invocationになるのでFree枠のsubrequestを分散できます。
      const queued=await kbnProcessQueuedMaintenanceV242(env);
      if(queued?.processed)return;

      const schedule=await kbnGetRuntimeScheduleV230(env);

      // v2.31:
      // 毎分起動し、設定時刻から5分以内の「まだ実行していない直近枠」を拾う。
      // Cron切替直後や一時的な遅延で時刻ちょうどを逃しても自動で追いつく。
      const due=kbnFindDueRuntimeSlotV231(event,schedule,5);
      if(!due)return;

      const fullMaintenance=due.time===schedule.full_maintenance_time_jst;
      const runType=fullMaintenance?"maintenance":"auto_listing";
      const claimed=await kbnClaimRuntimeSlotV231(env,due.minute_key,runType);
      if(!claimed)return; // 同じ予約枠は1日1回だけ

      let runId=0;
      try{
        runId=await kbnCronRunStartV224(env,event,runType);
        const result=fullMaintenance
          ?await runScheduledKbnMaintenance(env)
          :await runScheduledKbnAutoDiscoveryOnly(env);
        const createdCount=Number(result?.discovery?.created?.length||0);
        const diagnostic=kbnDiscoveryDiagnosticV226(result)||{};
        diagnostic.scheduled_slot=due.time;
        diagnostic.catch_up_minutes=due.diff;
        await kbnCronRunFinishV224(env,runId,{status:"success",createdCount,diagnostic});
      }catch(e){
        console.error(fullMaintenance?"runtime maintenance failed":"runtime auto discovery failed",e);
        try{await kbnCronRunFinishV224(env,runId,{status:"failed",error:String(e?.message||e)})}catch{}
      }
    })();
    ctx.waitUntil(task);
    await task;
  }
};
