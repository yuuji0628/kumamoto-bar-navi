const menuBtn=document.getElementById('menuBtn');
const nav=document.getElementById('nav');
menuBtn?.addEventListener('click',()=>{nav.classList.toggle('open');menuBtn.setAttribute('aria-expanded',nav.classList.contains('open'))});
nav?.querySelectorAll('a').forEach(a=>a.addEventListener('click',()=>nav.classList.remove('open')));

document.getElementById('filterBtn')?.addEventListener('click',()=>{
  const area=document.getElementById('areaFilter').value;
  const type=document.getElementById('typeFilter').value;
  const kw=document.getElementById('keyword').value.trim().toLowerCase();
  let count=0;
  document.querySelectorAll('.bar-card').forEach(card=>{
    const okArea=area==='all'||card.dataset.area===area;
    const okType=type==='all'||card.dataset.types.includes(type);
    const okKw=!kw||card.dataset.name.toLowerCase().includes(kw)||card.innerText.toLowerCase().includes(kw);
    const show=okArea&&okType&&okKw;
    card.style.display=show?'block':'none';
    if(show) count++;
  });
  document.getElementById('noResult').style.display=count===0?'block':'none';
  document.getElementById('search').scrollIntoView({behavior:'smooth'});
});