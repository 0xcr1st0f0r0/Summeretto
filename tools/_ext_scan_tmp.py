# 扫描 Edge 专用配置里的扩展身份（从 manifest 读名称/描述/来源）
import json, glob, os, sys

ROOTS = [
    'out/login-profile/Default/Extensions',
    'out/login-profile-magic/Default/Extensions',
]

def read_msg(bundle_dir, key):
    for loc in ('en', 'en_US', 'zh_CN', 'zh'):
        p = os.path.join(bundle_dir, '_locales', loc, 'messages.json')
        if os.path.exists(p):
            try:
                m = json.load(open(p, encoding='utf-8-sig'))
                if key in m:
                    return m[key].get('message', key)
            except Exception:
                pass
    return key

def resolve(bundle_dir, v):
    if isinstance(v, str) and v.startswith('__MSG_') and v.endswith('__'):
        return read_msg(bundle_dir, v[6:-2])
    return v

for root in ROOTS:
    print('=' * 70)
    print('配置:', root)
    if not os.path.isdir(root):
        print('  (不存在)')
        continue
    for eid in sorted(os.listdir(root)):
        if eid == 'Temp':
            continue
        hits = sorted(glob.glob(os.path.join(root, eid, '*', 'manifest.json')))
        if not hits:
            print(f'  ### {eid}  (无 manifest)')
            continue
        mf = hits[-1]
        bundle = os.path.dirname(os.path.dirname(mf))
        try:
            d = json.load(open(mf, encoding='utf-8-sig'))
        except Exception as ex:
            print(f'  ### {eid}  (解析失败: {ex})')
            continue
        name = resolve(bundle, d.get('name'))
        desc = str(resolve(bundle, d.get('description') or ''))[:140].replace('\n', ' ')
        print(f'  ### {eid}')
        print(f'      name   : {name}')
        print(f'      version: {d.get("version")}')
        print(f'      desc   : {desc}')
        print(f'      update : {d.get("update_url")}')
