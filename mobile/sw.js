'use strict';
// The static build replaces this revision with a fingerprint of its public assets.
const CACHE='folio-mobile-f6ab058c9df2c1461568';
const FILES=['./','./index.html','./mobile.css','./core.js','./storage.js','./drive.js','./app.js','./manifest.webmanifest','./icon-192.png','./icon-512.png','./config.json',
  '../favicon.svg','../css/base.css','../js/common/markup.js','../js/common/journal-rank.js','../js/common/citations.js','../vendor/katex/katex.min.css','../vendor/katex/katex.min.js',
  ...['KaTeX_AMS-Regular','KaTeX_Caligraphic-Bold','KaTeX_Caligraphic-Regular','KaTeX_Fraktur-Bold','KaTeX_Fraktur-Regular','KaTeX_Main-Bold','KaTeX_Main-BoldItalic','KaTeX_Main-Italic','KaTeX_Main-Regular','KaTeX_Math-BoldItalic','KaTeX_Math-Italic','KaTeX_SansSerif-Bold','KaTeX_SansSerif-Italic','KaTeX_SansSerif-Regular','KaTeX_Script-Regular','KaTeX_Size1-Regular','KaTeX_Size2-Regular','KaTeX_Size3-Regular','KaTeX_Size4-Regular','KaTeX_Typewriter-Regular'].map(n=>'../vendor/katex/fonts/'+n+'.woff2')];
const URLS=FILES.map(file=>new URL(file,self.location.href).href);
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(URLS)));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('folio-mobile-')&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{
  const request=event.request;
  // Google requests, tokens, and cloud content never enter the service-worker cache.
  if(request.method!=='GET' || new URL(request.url).origin!==self.location.origin || !URLS.includes(request.url.split('#')[0])) return;
  event.respondWith(caches.open(CACHE).then(async cache=>{
    if(new URL(request.url).pathname.endsWith('/config.json')) {
      try{const response=await fetch(request);if(response.ok){await cache.put(request,response.clone());return response;}}catch(_){}
    }
    const cached=await cache.match(request);
    if(cached) return cached;
    const response=await fetch(request);if(response.ok) await cache.put(request,response.clone());return response;
  }));
});
