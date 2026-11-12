"""Convert the Avande (Webflow) home page into Next.js components.

Usage (from anywhere):
    python -I scripts/convert.py <scrape_dir>

  <scrape_dir>  the folder holding the scraped site (index.html, cdn.prod.website_files.com/, ...)

Reads   source/index.html      pristine server HTML of https://avande-template.webflow.io/
Writes  components/*.tsx       page chrome (header, footer, promo buttons)
        components/sections/   one component per <section>
        public/assets/         images (copied from the scrape, missing ones fetched from the CDN)
        public/css/            Webflow stylesheet, asset urls pointed at /assets
        public/js/             Webflow runtime + GSAP + Lenis + the page's own inline scripts
"""
import json
import os
import re
import shutil
import sys
import urllib.request
from urllib.parse import urlparse

from bs4 import BeautifulSoup, NavigableString, Comment

OUT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(OUT, 'source', 'index.html')

VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
        'meta', 'param', 'source', 'track', 'wbr'}

ATTR_MAP = {
    'class': 'className', 'for': 'htmlFor', 'tabindex': 'tabIndex',
    'colspan': 'colSpan', 'rowspan': 'rowSpan', 'maxlength': 'maxLength',
    'autocomplete': 'autoComplete', 'autofocus': 'autoFocus', 'autoplay': 'autoPlay',
    'playsinline': 'playsInline', 'crossorigin': 'crossOrigin', 'srcset': 'srcSet',
    'readonly': 'readOnly', 'contenteditable': 'contentEditable', 'spellcheck': 'spellCheck',
    'enctype': 'encType', 'novalidate': 'noValidate', 'usemap': 'useMap',
    'accesskey': 'accessKey', 'srclang': 'srcLang', 'datetime': 'dateTime',
    'fetchpriority': 'fetchPriority', 'referrerpolicy': 'referrerPolicy',
    'inputmode': 'inputMode', 'allowfullscreen': 'allowFullScreen',
    'frameborder': 'frameBorder', 'disablepictureinpicture': 'disablePictureInPicture',
    'disableremoteplayback': 'disableRemotePlayback',
    'viewbox': 'viewBox', 'preserveaspectratio': 'preserveAspectRatio',
    'stroke-width': 'strokeWidth', 'stroke-linecap': 'strokeLinecap',
    'stroke-linejoin': 'strokeLinejoin', 'stroke-miterlimit': 'strokeMiterlimit',
    'stroke-dasharray': 'strokeDasharray', 'stroke-dashoffset': 'strokeDashoffset',
    'stroke-opacity': 'strokeOpacity', 'fill-rule': 'fillRule', 'fill-opacity': 'fillOpacity',
    'clip-rule': 'clipRule', 'clip-path': 'clipPath', 'clippathunits': 'clipPathUnits',
    'stop-color': 'stopColor', 'stop-opacity': 'stopOpacity',
    'gradientunits': 'gradientUnits', 'gradienttransform': 'gradientTransform',
    'patternunits': 'patternUnits', 'maskunits': 'maskUnits',
    'text-anchor': 'textAnchor', 'font-family': 'fontFamily', 'font-size': 'fontSize',
    'font-weight': 'fontWeight', 'letter-spacing': 'letterSpacing',
    'xlink:href': 'xlinkHref', 'xml:space': 'xmlSpace',
    'stddeviation': 'stdDeviation', 'floodcolor': 'floodColor',
    'flood-color': 'floodColor', 'flood-opacity': 'floodOpacity',
    'color-interpolation-filters': 'colorInterpolationFilters',
    'filterunits': 'filterUnits', 'baseprofile': 'baseProfile',
}

BOOLEAN_ATTRS = {'loop', 'muted', 'autoplay', 'playsinline', 'controls', 'disabled',
                 'checked', 'readonly', 'required', 'selected', 'async', 'defer',
                 'hidden', 'multiple', 'novalidate', 'open', 'reversed',
                 'allowfullscreen', 'inert', 'disablepictureinpicture',
                 'disableremoteplayback'}

NUMERIC_ATTRS = {'tabindex', 'rowspan', 'colspan', 'span', 'start', 'maxlength'}

# The source is the pristine server HTML, so every style attribute in it is an
# authored Webflow initial state (not runtime junk) and is kept.
DROP_ATTRS = {'xmlns:xlink'}

SITE_ASSET = re.compile(r'https://cdn\.prod\.website-files\.com/[0-9a-f]{24}/([^/"\'\s]+)')

assets = set()  # every CDN asset url the page or its stylesheet references


def local_name(url: str) -> str:
    """Same naming the scraper used: lowercase, anything outside [a-z0-9._] -> _."""
    base = urlparse(url).path.rsplit('/', 1)[-1].lower()
    return re.sub(r'[^a-z0-9._]', '_', base)


def rewrite(url: str) -> str:
    if url and SITE_ASSET.fullmatch(url):
        assets.add(url)
        return '/assets/' + local_name(url)
    return url


def css_prop(name: str) -> str:
    name = name.strip()
    if name.startswith('--'):
        return name
    if name.startswith('-ms-'):
        name = 'ms-' + name[4:]
    elif name.startswith('-'):
        name = name[1:].capitalize()
    head, *rest = name.split('-')
    return head + ''.join(p.capitalize() for p in rest)


def jsx_style(value: str) -> str:
    pairs = []
    for decl in value.split(';'):
        if ':' not in decl:
            continue
        k, v = decl.split(':', 1)
        pairs.append(f'{json.dumps(css_prop(k))}: {json.dumps(v.strip())}')
    return 'style={{ ' + ', '.join(pairs) + ' }}'


def jsx_attr(name, value):
    if name in DROP_ATTRS:
        return None
    if isinstance(value, list):
        value = ' '.join(value)
    if name == 'style':
        return jsx_style(str(value))
    if name in ('src', 'href', 'poster'):
        value = rewrite(str(value))
    elif name == 'srcset':
        parts = []
        for chunk in str(value).split(','):
            chunk = chunk.strip()
            if not chunk:
                continue
            bits = chunk.split()
            bits[0] = rewrite(bits[0])
            parts.append(' '.join(bits))
        value = ', '.join(parts)

    prop = ATTR_MAP.get(name, name)
    if name in BOOLEAN_ATTRS and (value is None or str(value).strip() in ('', 'true')):
        return prop
    if name in NUMERIC_ATTRS:
        try:
            return f'{prop}={{{int(str(value).strip())}}}'
        except ValueError:
            pass
    if value is None:
        value = ''
    value = str(value)
    # JSX string attributes decode entities and cannot hold a raw quote/newline
    if re.search(r'["&\n\\{}]', value) or not value.isascii():
        return f'{prop}={{{js_string(value)}}}'
    return f'{prop}="{value}"'


def js_string(s: str) -> str:
    return json.dumps(s, ensure_ascii=False).replace('\u2028', '\\u2028').replace('\u2029', '\\u2029')


SAFE_TEXT = re.compile(r"[A-Za-z0-9 .,!?:;()'’\-–—+%$@/#*©|“”]+")


def jsx_text(s: str) -> str:
    """Emit text exactly as authored; anything JSX could reinterpret goes in a string literal."""
    if SAFE_TEXT.fullmatch(s) and s == s.strip() and '  ' not in s:
        return s
    return '{' + js_string(s) + '}'


def in_svg(node) -> bool:
    return node.name == 'svg' or node.find_parent('svg') is not None


def to_jsx(node, depth=1):
    pad = '  ' * depth
    if isinstance(node, Comment):
        return ''
    if isinstance(node, NavigableString):
        t = str(node)
        if not t.strip():
            # layout whitespace between svg shapes is not rendered; elsewhere keep it
            parent = node.parent
            if in_svg(parent) and parent.name not in ('text', 'tspan'):
                return ''
            return pad + '{" "}\n'
        return pad + jsx_text(t) + '\n'
    if node.name in ('script', 'noscript'):
        return ''

    attrs = [a for a in (jsx_attr(k, v) for k, v in node.attrs.items()) if a]
    attr_s = (' ' + ' '.join(attrs)) if attrs else ''
    kids = [c for c in node.children if to_jsx(c, 0)]
    if node.name in VOID or not kids:
        return f'{pad}<{node.name}{attr_s} />\n'
    inner = ''.join(to_jsx(c, depth + 1) for c in kids)
    return f'{pad}<{node.name}{attr_s}>\n{inner}{pad}</{node.name}>\n'


def component(name, node):
    return f"""export default function {name}() {{
  return (
{to_jsx(node, 2).rstrip()}
  );
}}
"""


# (selector, component) - direct children of <body>
CHROME = [
    ('template-buttons-wrapper', 'TemplateButtons'),
]

# direct children of .page-wrapper, in page order
PAGE_CHROME = [
    ('main-header-section', 'Header'),
    ('footer-section', 'Footer'),
]

SECTIONS = [
    ('hero-banner-section', 'Hero'),
    ('brand-logo-section', 'BrandLogos'),
    ('home-about-sectin', 'About'),
    ('feature-section', 'Features'),
    ('intelligent-section', 'Intelligent'),
    ('statitics-section', 'Statistics'),
    ('utility-section', 'Utility'),
    ('benefits-section', 'Benefits'),
    ('service-section', 'Services'),
    ('testimonials-section', 'Testimonials'),
    ('process-section', 'Process'),
    ('home-blogs-section', 'Blogs'),
    ('home-pricing-section', 'Pricing'),
    ('automation-section', 'Automation'),
    ('faq-section', 'Faq'),
    ('cta-section', 'Cta'),
]

# body scripts, in the order the page loads them -> public/js name
RUNTIME = [
    ('d3e54v103j8qbb.cloudfront.net/js/jquery_3.5.1.min.dc5e7f18c8.js', 'jquery-3.5.1.min.js'),
    ('cdn.prod.website_files.com/6a901794a3ca5e0a74527dde/js/webflow.schunk.a3140c51201be139.js', 'webflow.schunk.a3140c51201be139.js'),
    ('cdn.prod.website_files.com/6a901794a3ca5e0a74527dde/js/webflow.schunk.7f02404addf2d9bb.js', 'webflow.schunk.7f02404addf2d9bb.js'),
    ('cdn.prod.website_files.com/6a901794a3ca5e0a74527dde/js/webflow.54de4acb.9272109727951c45.js', 'webflow.54de4acb.9272109727951c45.js'),
    ('cdn.prod.website_files.com/gsap/3.15.0/gsap.min.js', 'gsap.min.js'),
    ('cdn.prod.website_files.com/gsap/3.15.0/splittext.min.js', 'SplitText.min.js'),
    ('cdn.prod.website_files.com/gsap/3.15.0/scrolltrigger.min.js', 'ScrollTrigger.min.js'),
    ('unpkg.com/lenis_1.3.23/dist/lenis.min.js', 'lenis.min.js'),
    ('ajax.googleapis.com/ajax/libs/webfont/1.6.26/webfont.js', 'webfont.js'),
]

CSS_SRC = 'cdn.prod.website_files.com/6a901794a3ca5e0a74527dde/css/avande_template.webflow.shared.40aea3886.css'

DOM_READY = 'document.addEventListener("DOMContentLoaded", '

CUSTOM_HEADER = """/*
 * The page's own inline <script> blocks, verbatim and in page order.
 *
 * Only difference from the Webflow export: this file is injected after React
 * hydrates, by which time DOMContentLoaded has already fired, so
 *   document.addEventListener("DOMContentLoaded", fn)
 * is written as
 *   __avandeDomReady(fn)
 * which simply calls fn. WebflowRuntime.tsx holds jQuery's ready event until
 * this file has run, so these still execute before Webflow.ready, as on the
 * original page.
 */
function __avandeDomReady(fn) { fn(); }
"""


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    scrape = sys.argv[1]

    soup = BeautifulSoup(open(SRC, encoding='utf-8').read(), 'html5lib')
    body = soup.body

    # the page's own inline scripts, before they are stripped from the tree
    inline = [s.string for s in body.find_all('script', src=False)]

    for t in body.find_all(['script', 'noscript', 'iframe']):
        t.decompose()
    for c in body.find_all(string=lambda s: isinstance(s, Comment)):
        c.extract()

    page = body.find(class_='page-wrapper', recursive=False)

    for cls, name in CHROME:
        node = body.find(class_=cls, recursive=False)
        if node is None:
            print('!! missing chrome', cls)
            continue
        write(f'{OUT}/components/{name}.tsx', component(name, node))

    for cls, name in PAGE_CHROME:
        node = page.find(class_=cls, recursive=False)
        if node is None:
            print('!! missing chrome', cls)
            continue
        write(f'{OUT}/components/{name}.tsx', component(name, node))

    for cls, name in SECTIONS:
        node = page.find(class_=cls, recursive=False)
        if node is None:
            print('!! missing section', cls)
            continue
        write(f'{OUT}/components/sections/{name}.tsx', component(name, node))

    known = {c for c, _ in PAGE_CHROME + SECTIONS}
    for child in page.find_all(True, recursive=False):
        if not known & set(child.get('class', [])):
            print('!! unconverted child of .page-wrapper:', child.name, child.get('class'))

    # stylesheet: byte-identical except asset urls now point at /assets
    css = open(os.path.join(scrape, CSS_SRC), encoding='utf-8').read()
    css = SITE_ASSET.sub(lambda m: rewrite(m.group(0)), css)
    write(f'{OUT}/public/css/avande.webflow.css', css)

    # the <style> block Webflow inlines in <head>: hides animated elements until IX3 boots
    write(f'{OUT}/public/css/ix-initial-state.css',
          '\n'.join(s.string for s in soup.head.find_all('style')) + '\n')

    # favicons live in <head>
    for link in soup.head.find_all('link', href=True):
        rewrite(link['href'])

    # runtime scripts
    os.makedirs(f'{OUT}/public/js', exist_ok=True)
    for src, name in RUNTIME:
        shutil.copyfile(os.path.join(scrape, src), f'{OUT}/public/js/{name}')

    n_ready = sum(s.count(DOM_READY) for s in inline)
    custom = CUSTOM_HEADER + ''.join(
        f'\n/* ---- inline script {i + 1} of {len(inline)} ---- */\n'
        + s.strip('\n').replace(DOM_READY, '__avandeDomReady(') + '\n'
        for i, s in enumerate(inline))
    write(f'{OUT}/public/js/custom.js', custom)

    # images: reuse the scrape, fetch what it lacks
    have = {}
    for root, _, files in os.walk(scrape):
        if os.path.abspath(root).startswith(OUT):
            continue
        for f in files:
            have[f.lower()] = os.path.join(root, f)
    os.makedirs(f'{OUT}/public/assets', exist_ok=True)
    copied = fetched = 0
    for url in sorted(assets):
        name = local_name(url)
        dest = f'{OUT}/public/assets/{name}'
        if name in have:
            shutil.copyfile(have[name], dest)
            copied += 1
        else:
            if not os.path.exists(dest):
                req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
                with urllib.request.urlopen(req, timeout=60) as r, open(dest, 'wb') as f:
                    f.write(r.read())
            fetched += 1
            print('   fetched', name)

    print('chrome:', [n for _, n in CHROME + PAGE_CHROME])
    print('sections:', [n for _, n in SECTIONS])
    print(f'assets: {copied} copied from scrape, {fetched} fetched from CDN')
    print(f'custom.js: {len(inline)} inline scripts, {n_ready} DOMContentLoaded handlers rewritten')


if __name__ == '__main__':
    main()
