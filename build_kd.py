"""Builds kitchen-design-plan.html from the planner file (run from the kitchen repo folder).
usage: python build_kd.py <path to planner.html>
"""
import re, sys
src = sys.argv[1]
t = open(src, encoding='utf8').read()

# our own copies of the libraries (no outside hosts)
swap = {
 "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js": "lib/kd-three.min.js",
 "https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js": "lib/kd-orbit.js",
 "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js": "lib/kd-jspdf.min.js",
 "https://cdn.jsdelivr.net/npm/svg2pdf.js@2.2.3/dist/svg2pdf.umd.min.js": "lib/kd-svg2pdf.min.js",
}
for a, b in swap.items():
    assert t.count(a) == 1, a
    t = t.replace(a, b)

# one browser copy per project, and a first open loads the project's team plan
proj = {
 "const KEY='mkp.v2';": "const KEY='mkp.v2.'+(window.KD_PROJECT||'');const KD_FRESH=(()=>{try{return !localStorage.getItem(KEY)}catch(e){return true}})();",
 "teamBase=+localStorage.getItem('mkp.teamrev')||0": "teamBase=+localStorage.getItem('mkp.teamrev.'+(window.KD_PROJECT||''))||0",
 "localStorage.setItem('mkp.teamrev',String(n))": "localStorage.setItem('mkp.teamrev.'+(window.KD_PROJECT||''),String(n))",
 "teamLoaded=true;teamDoc=s.exists?s.data():null;teamStatus()": "teamLoaded=true;teamDoc=s.exists?s.data():null;teamStatus();if(KD_FRESH&&teamDoc&&!window.__kdFirst){window.__kdFirst=1;try{teamApply(teamDoc)}catch(e){console.error(e)}}",
}
for a, b in proj.items():
    assert t.count(a) == 1, a
    t = t.replace(a, b)

# the planner is a Claude Artifact page: strip the build stamp wording only
key = re.search(r"SUPABASE_KEY\s*=\s*'([^']+)'", open('app.js', encoding='latin-1').read()).group(1)
shim = open('kd-shim.js', encoding='utf8').read().replace('__KD_ANON_KEY__', key)
open('kd-shim.js', 'w', encoding='utf8').write(shim)

head = ('<!doctype html>\n<html lang="en" translate="no">\n<head>\n<meta charset="utf-8">\n<meta name="google" content="notranslate">\n'
        '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'
        '<script src="dev-guard.js"></script>\n'
        '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>\n'
        '<script src="kd-shim.js"></script>\n'
        '<style>*{box-sizing:border-box}html,body{margin:0}</style>\n</head>\n<body>\n')
out = head + t + '\n</body>\n</html>\n'
open('kitchen-design-plan.html', 'w', encoding='utf8').write(out)
print('written', len(out), 'bytes')
