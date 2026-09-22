# Turns the blank Candidate Evaluation Form into a template: one {{TOKEN}} in each box to fill.
import zipfile, copy, sys, re
from lxml import etree
W='http://schemas.openxmlformats.org/wordprocessingml/2006/main'
def q(t): return '{%s}%s'%(W,t)
SRC, OUT = sys.argv[1], sys.argv[2]
zin=zipfile.ZipFile(SRC)
root=etree.fromstring(zin.read('word/document.xml'))
body=root.find(q('body'))
main=body.find(q('tbl'))
def cells(tr): return tr.findall(q('tc'))
def text(el): return ''.join(el.itertext()).strip()
def put(tc, token, center=False, tick=False, para=None):
    p = para if para is not None else tc.findall(q('p'))[0]
    assert text(p)=='' , ('paragraph not empty', token, text(p))
    ppr=p.find(q('pPr'))
    if ppr is None: ppr=etree.SubElement(p,q('pPr')); p.remove(ppr); p.insert(0,ppr)
    if center:
        jc=ppr.find(q('jc'))
        if jc is None:
            jc=etree.Element(q('jc')); 
            # jc must come before rPr inside pPr
            rp=ppr.find(q('rPr'))
            if rp is not None: rp.addprevious(jc)
            else: ppr.append(jc)
        jc.set(q('val'),'center')
    r=etree.SubElement(p,q('r'))
    rpr=etree.SubElement(r,q('rPr'))
    src=ppr.find(q('rPr'))
    if src is not None and not tick:
        for ch in src: rpr.append(copy.deepcopy(ch))
    if tick:
        f=etree.SubElement(rpr,q('rFonts'))
        for a in ('ascii','hAnsi','cs','eastAsia'): f.set(q(a),'Segoe UI Symbol')
        etree.SubElement(rpr,q('b'))
        sz=etree.SubElement(rpr,q('sz')); sz.set(q('val'),'18')
    else:
        for tag in ('b','bCs'):            # the labels are bold; what the chef writes is not
            for e in rpr.findall(q(tag)): rpr.remove(e)
    t=etree.SubElement(r,q('t')); t.text='{{%s}}'%token
    t.set('{http://www.w3.org/XML/1998/namespace}space','preserve')

# "Recommended Salary:" is not on HR's blank form (added 22 Sep 2026): a copy of the Position row,
# its value cell spanning the rest of the row
W14='http://schemas.microsoft.com/office/word/2010/wordml'
def add_salary_row(pos_tr):
    tr=copy.deepcopy(pos_tr)
    for el in tr.iter():
        for a in list(el.attrib):
            if a.startswith('{%s}'%W14): del el.attrib[a]
    cs=cells(tr)
    ts=cs[0].findall('.//'+q('t')); ts[0].text='Recommended Salary:'
    for t in ts[1:]: t.text=''
    span=sum(int(c.find(q('tcPr')).find(q('gridSpan')).get(q('val'))) for c in cs[1:])
    width=sum(int(c.find(q('tcPr')).find(q('tcW')).get(q('w'))) for c in cs[1:])
    v=cs[1]
    v.find(q('tcPr')).find(q('gridSpan')).set(q('val'),str(span))
    v.find(q('tcPr')).find(q('tcW')).set(q('w'),str(width))
    for c in cs[2:]: tr.remove(c)
    ps=v.findall(q('p'))
    for extra in ps[1:]: v.remove(extra)
    t=ps[0].findall('.//'+q('t')); assert len(t)==1 and t[0].text=='{{POSITION}}'
    t[0].text='{{SALARY}}'
    pos_tr.addnext(tr)

rows=main.findall(q('tr'))
done=[]
for tr in rows:
    cs=cells(tr); first=text(cs[0]) if cs else ''
    if first.startswith('Name of Candidate'):
        put(cs[1],'NAME'); done.append('NAME')
    elif first.startswith('Name of Interviewer'):
        put(cs[1],'INTERVIEWERS'); done.append('INTERVIEWERS')
        for tc,tok in zip(cs[2:5],('D_HIRED','D_HOLD','D_REJECT')):
            inner=tc.find(q('tbl')); ic=inner.find(q('tr')).find(q('tc'))
            put(ic,tok,center=True,tick=True); done.append(tok)
    elif first.startswith('Position'):
        put(cs[1],'POSITION'); put(cs[3],'DEPARTMENT')
        for tc in (cs[1],cs[3]):
            jc=tc.findall(q('p'))[0].find(q('pPr')).find(q('jc'))
            if jc is not None: jc.set(q('val'),'left'); done+= ['POSITION','DEPARTMENT']
        add_salary_row(tr); done.append('SALARY')
    elif re.match(r'^(\d+)\.\s',first) or first.startswith('OVERALL RATING'):
        m=re.match(r'^(\d+)\.',first); key='R'+m.group(1) if m else 'RO'
        assert len(cs)==5,(key,len(cs))
        for tc,s in zip(cs[1:],'EGAP'):
            put(tc,'%s_%s'%(key,s),center=True,tick=True)
        done.append(key)
    elif first.startswith('Signature of Interviewer'):
        put(cs[1],'SIGNATURE'); put(cs[3],'DATE'); done+=['SIGNATURE','DATE']
# comments: the single wide empty cell right after the "General Comments" row
for i,tr in enumerate(rows):
    if text(tr).startswith('General Comments'):
        tc=cells(rows[i+1])[0]; assert text(tc)==''
        ps=tc.findall(q('p'))
        for extra in ps[1:]:
            if text(extra)=='': tc.remove(extra)
        put(tc,'COMMENTS'); done.append('COMMENTS'); print('comment blank lines removed:',len(ps)-1)
tail=[p for p in body.findall(q('p'))]
for p in tail:
    if text(p)=='':
        ppr=p.find(q('pPr'))
        if ppr is None: ppr=etree.Element(q('pPr')); p.insert(0,ppr)
        sp=ppr.find(q('spacing'))
        if sp is None: sp=etree.SubElement(ppr,q('spacing'))
        sp.set(q('before'),'0'); sp.set(q('after'),'0'); sp.set(q('line'),'20'); sp.set(q('lineRule'),'exact')
        rp=ppr.find(q('rPr'))
        if rp is None: rp=etree.SubElement(ppr,q('rPr'))
        for e in rp.findall(q('sz'))+rp.findall(q('szCs')): rp.remove(e)
        z=etree.SubElement(rp,q('sz')); z.set(q('val'),'2')
print('empty body paragraphs shrunk:',len([p for p in tail if text(p)=='']))
print('tokens placed:',done)
xml=etree.tostring(root,xml_declaration=True,encoding='UTF-8',standalone=True)
zout=zipfile.ZipFile(OUT,'w',zipfile.ZIP_DEFLATED)
for it in zin.infolist():
    zout.writestr(it, xml if it.filename=='word/document.xml' else zin.read(it.filename))
zout.close()
x=xml.decode('utf8'); print('token count', len(re.findall(r'\{\{[A-Z0-9_]+\}\}',x)))
