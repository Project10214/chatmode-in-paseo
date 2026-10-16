#!/usr/bin/env python3
"""Read-only line-level reuse audit: this project vs. pinned Chat On Steroids (CoS) checkouts.

usage: audit-upstream-reuse.py PROJECT_ROOT UPSTREAM_CCD23B66 UPSTREAM_E4056264

Only reads text files. Nothing from the upstream trees is imported or executed.
A project line "matches" when, after collapsing whitespace, it is identical to a line
(>= MIN_LEN chars) somewhere in either upstream checkout. That undercounts renamed or
reformatted code and overcounts boilerplate, so numbers are indicative, not exact.
"""
import hashlib
import json
import os
import sys
from collections import Counter, defaultdict

MIN_LEN = 20
MAX_LEN = 2000
UP_EXTS = {'.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.html'}
PROJ_EXTS = UP_EXTS | {'.py'}
SKIP = {'node_modules', '.git', 'dist', 'build', '.work', '.test-tools', '.local-backups',
        'reference', 'artifacts', 'coverage', '__pycache__', '.state'}
TRIVIAL = ('import ', 'export {', 'export *', '} from', '//', '/*', '*/', '* ', '#',
           "'use strict'", '"use strict"')


def norm(s):
    return ' '.join(s.split())


def walk(root, exts):
    for dp, dns, fns in os.walk(root):
        dns[:] = sorted(d for d in dns if d not in SKIP)
        for fn in sorted(fns):
            if os.path.splitext(fn)[1].lower() in exts:
                p = os.path.join(dp, fn)
                if os.path.islink(p):
                    continue
                yield p, os.path.relpath(p, root)


def read_lines(p):
    try:
        with open(p, encoding='utf-8', errors='replace') as f:
            return [norm(x) for x in f.read().splitlines()]
    except OSError:
        return []


def build_upstream(roots):
    index = defaultdict(set)
    files = {}
    nonblank = Counter()
    for tag, root in roots:
        for p, rel in walk(root, UP_EXTS):
            nb = [l for l in read_lines(p) if l]
            nonblank[tag] += len(nb)
            cons = [l for l in nb if MIN_LEN <= len(l) <= MAX_LEN]
            files[(tag, rel)] = cons
            for l in set(cons):
                s = index[l]
                if len(s) < 8:
                    s.add((tag, rel))
    return index, files, nonblank


def category(rel):
    parts = rel.split(os.sep)
    if rel.startswith('extension' + os.sep + 'upstream' + os.sep):
        return 'A extension/upstream (CoS transplant modules)'
    if parts[0] == 'extension':
        return 'B extension (rest)'
    if parts[0] == 'server':
        return 'C server'
    if parts[0] in ('client', 'shared') or rel in ('index.server.ts', 'index.client.tsx'):
        return 'D client+shared+plugin entry'
    if parts[0] == 'scripts':
        return 'E scripts'
    if parts[0] == 'tests':
        return 'F tests'
    return 'G other'


def classify(l, index):
    if len(l) < MIN_LEN:
        return 'S'
    if len(l) <= MAX_LEN and l in index:
        return 'M'
    return 'U'


def analyze(lines, index):
    nb = [l for l in lines if l]
    kinds = [classify(l, index) for l in nb]
    sub = [l for l in nb if len(l) >= 25 and not l.startswith(TRIVIAL)]
    run_lines = longest = cur = 0
    for k in kinds:
        if k == 'M':
            cur += 1
        elif k == 'U':
            if cur >= 3:
                run_lines += cur
            longest = max(longest, cur)
            cur = 0
    if cur >= 3:
        run_lines += cur
    longest = max(longest, cur)
    return {
        'total': len(nb),
        'cons': sum(k != 'S' for k in kinds),
        'match': sum(k == 'M' for k in kinds),
        'sub': len(sub),
        'sub_match': sum(1 for l in sub if l in index),
        'runs': run_lines,
        'longest': longest,
    }


def add(a, b):
    for k, v in b.items():
        a[k] = max(a.get(k, 0), v) if k == 'longest' else a.get(k, 0) + v


def pct(a, b):
    return f'{100 * a / b:.1f}%' if b else '-'


def row(name, r):
    return (f"{name}: non-blank {r['total']}, comparable(>= {MIN_LEN} chars) {r['cons']}, "
            f"identical {r['match']} ({pct(r['match'], r['cons'])}); "
            f"substantive-code {r['sub']} -> identical {r['sub_match']} ({pct(r['sub_match'], r['sub'])}); "
            f"in >=3-line verbatim blocks {r['runs']} ({pct(r['runs'], r['cons'])}); longest block {r['longest']}")


def main():
    project, u1, u2 = sys.argv[1:4]
    roots = [('ccd23b66', u1), ('e4056264', u2)]
    index, up_files, up_nb = build_upstream(roots)
    print(f'UPSTREAM code lines (js/mjs/cjs/ts/tsx/css/html, non-blank): {dict(up_nb)}; distinct comparable lines: {len(index)}')

    cats, per_file, runtime = defaultdict(dict), {}, set()
    for p, rel in walk(project, PROJ_EXTS):
        ls = read_lines(p)
        r = analyze(ls, index)
        c = category(rel)
        add(cats[c], r)
        per_file[rel] = r
        if c[0] in 'ABCDE':
            runtime.update(l for l in ls if MIN_LEN <= len(l) <= MAX_LEN)

    print('\n## PROJECT side: how much of our code is identical to CoS lines')
    tot = {}
    for c in sorted(cats):
        print(row(c, cats[c]))
        if c[0] in 'ABCDE':
            add(tot, cats[c])
    print(row('RUNTIME TOTAL (A-E)', tot))

    print('\n## per transplant module (extension/upstream)')
    for rel in sorted(per_file):
        if not rel.startswith('extension/upstream/'):
            continue
        r = per_file[rel]
        src = Counter()
        for l in set(read_lines(os.path.join(project, rel))):
            for urel in {u for _, u in index.get(l, ())}:
                src[urel] += 1
        top = ', '.join(f'{u}:{n}' for u, n in src.most_common(2))
        print(f"{rel}: lines {r['total']}, identical {r['match']}/{r['cons']} ({pct(r['match'], r['cons'])}), "
              f"verbatim-block lines {r['runs']}, longest {r['longest']}; top upstream sources: {top}")

    print('\n## UPSTREAM side: how much of CoS appears in our runtime code')
    for tag, _ in roots:
        agg = defaultdict(lambda: [0, 0])
        for (t, rel), cons in up_files.items():
            if t != tag:
                continue
            used = sum(1 for l in cons if l in runtime)
            area = 'extension/' if rel.startswith('extension/') else ('src/' if rel.startswith('src/') else 'other')
            agg[area][0] += len(cons)
            agg[area][1] += used
            agg['ALL'][0] += len(cons)
            agg['ALL'][1] += used
        print(f'[{tag}] ' + '; '.join(f'{a}: {u}/{n} ({pct(u, n)})' for a, (n, u) in sorted(agg.items())))
    print('core upstream files, e4056264 (lines present in our runtime / comparable lines):')
    for (t, rel), cons in sorted(up_files.items()):
        if t == 'e4056264' and rel.startswith('extension/') and rel.count('/') == 1 and cons:
            used = sum(1 for l in cons if l in runtime)
            if used:
                print(f'  {rel}: {used}/{len(cons)} ({pct(used, len(cons))})')
    print('core upstream files, ccd23b66:')
    for rel in ('extension/chatgpt-dom.js', 'extension/fiber.js'):
        cons = up_files.get(('ccd23b66', rel), [])
        used = sum(1 for l in cons if l in runtime)
        print(f'  {rel}: {used}/{len(cons)} ({pct(used, len(cons))})')

    print('\n## provenance.json (our own record)')
    prov = json.load(open(os.path.join(project, 'vendor/cos/provenance.json'), encoding='utf-8'))
    fl = prov['files']
    funcs = sum(len(f.get('sourceFunctions', [])) + len(f.get('sourceArrowFunctions', [])) for f in fl)
    srcs = Counter(f"{f.get('sourcePath', f.get('sourceUrl', '?'))}@{f.get('sourceCommit', prov.get('commit', ''))[:8]}" for f in fl)
    print(f"modules: {len(fl)}; recorded source functions: {funcs}; license: {prov.get('license')}")
    print('upstream sources used: ' + ', '.join(f'{k} x{v}' for k, v in sorted(srcs.items())))

    print('\n## .work upstream copies vs pinned upstream (sha256)')
    for name in ('content.js', 'fiber.js'):
        wp = os.path.join(project, '.work/receipt-20261013/upstream', name)
        if not os.path.exists(wp):
            continue
        h = hashlib.sha256(open(wp, 'rb').read()).hexdigest()
        for tag, root in roots:
            up = os.path.join(root, 'extension', name)
            if os.path.exists(up):
                same = h == hashlib.sha256(open(up, 'rb').read()).hexdigest()
                print(f'  .work/.../{name} vs {tag}/extension/{name}: {"IDENTICAL" if same else "differs"}')


if __name__ == '__main__':
    main()
