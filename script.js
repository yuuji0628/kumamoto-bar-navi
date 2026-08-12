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
    card.style.display=show?'block':'none';
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
