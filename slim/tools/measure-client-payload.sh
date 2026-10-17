#!/bin/bash
# Per-page client download bytes, computed from the Next build manifests inside the
# running containers (this is exactly what a browser fetches for that route),
# plus the weight of fonts and the Monaco editor bundle.
set -uo pipefail

probe() {
  cname="$1"; label="$2"
  echo "----- $label ($cname)"
  docker exec "$cname" node -e '
    const fs=require("fs"), path=require("path");
    const roots=["/app/apps/game/.next/standalone/apps/game/.next","/app/apps/game/.next/server/../static","/app/apps/game/.next/static"];
    let dir=null;
    for (const r of roots) { try { if (fs.existsSync(path.join(r,"build-manifest.json"))) { dir=r; break; } } catch(e){} }
    if (!dir) { console.log("no build-manifest found"); process.exit(0); }
    // locate the static chunk dir
    let staticDir=null;
    for (const c of [path.join(dir,"static"), path.join(dir,"../static"), "/app/apps/game/.next/static",
                     path.join(dir,"standalone/apps/game/.next/static")]) {
      try { if (fs.existsSync(c)) { staticDir=c; break; } } catch(e){}
    }
    const bm=JSON.parse(fs.readFileSync(path.join(dir,"build-manifest.json"),"utf8"));
    const sz=(f)=>{ for (const base of [path.join(dir,".."), staticDir||dir, dir]) {
        try { const p=path.join(base,f); if (fs.existsSync(p)) return fs.statSync(p).size; } catch(e){} }
      return 0; };
    const show=["/","/p/[world]","/play-system","/login","/edit","/works"];
    const keys=Object.keys(bm.pages||{});
    console.log("pages in manifest:", keys.length, "| staticDir:", staticDir);
    const rows=[];
    for (const k of keys) {
      const files=[...(new Set([...(bm.pages["/_app"]||[]),...(bm.pages["/_error"]||[]),...(bm.pages[k]||[])]))];
      let b=0; for (const f of files) b+=sz(f);
      rows.push([k, files.length, b]);
    }
    rows.sort((a,b)=>b[2]-a[2]);
    for (const [k,n,b] of rows.slice(0,14)) console.log("   "+String(b).padStart(10)+" B  chunks="+String(n).padStart(3)+"  "+k);
    const shared=[...(new Set([...(bm.pages["/_app"]||[]),...(bm.pages["/_error"]||[]),...(bm.files||[])]))];
    let sb=0; for (const f of shared) sb+=sz(f);
    console.log("   shared (_app/_error/beforeFiles) = "+sb+" B over "+shared.length+" files");
  ' 2>&1 | sed 's/^/  /'
  echo "   fonts + monaco actually shipped in this image:"
  docker exec "$cname" sh -c '
    for d in /app/apps/game/.next/standalone/apps/game/.next/static/media /app/apps/game/.next/static/media; do
      [ -d "$d" ] && echo "     media $d -> $(du -sh $d | cut -f1)"
    done
    for d in /app/apps/game/.next/standalone/apps/game/.next/static/vs /app/apps/game/.next/static/vs; do
      [ -d "$d" ] && echo "     monaco $d -> $(du -sh $d | cut -f1)"
    done
    echo "     largest media files:"
    for d in /app/apps/game/.next/standalone/apps/game/.next/static/media /app/apps/game/.next/static/media; do
      [ -d "$d" ] && find $d -type f -printf "       %s\t%p\n" | sort -rn | head -6 | numfmt --to=iec --field=1
    done
  ' 2>&1 | sed 's/^/  /'
}

probe box-local-engine-play-1 "PLAY"
echo
probe box-local-engine-creator-1 "CREATOR"
echo
echo "----- wire measurement recap (compressed, curl --compressed, from tools/measure-payload.sh):"
echo "     Play 首页 = 51,535 B HTML + 20 assets = 315,903 B (308 KiB)  [实测]"
echo "     /p/<map> 与 Creator / 返回 466 B（需登录态跳转），故改用上面的 manifest 口径"
