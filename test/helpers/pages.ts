// Trang mẫu hợp lệ cho test: một khối chữ như editor lưu thật (kiểm bằng isPageData và validatePage của Miditor).
// `image` thêm một khối ảnh; `metaImage` đặt ảnh chia sẻ của trang.
export function samplePage(text = 'Your text', options: { image?: string; metaImage?: string } = {}) {
  const textBlock = {
    id: 'n1',
    type: 'Text',
    props: { text, size: 24, color: '#111111', bold: false, italic: false, underline: false, align: 'center', font: '' },
    styles: {},
    position: { mode: 'free', x: { anchor: 'scale', start: 37.5, size: 25 }, y: { anchor: 'start', offset: 290 } },
    size: { w: { kind: 'px', v: 240 }, h: { kind: 'px', v: 60 } },
    rotation: 0,
    children: [],
  };
  const imageBlock = {
    id: 'n2',
    type: 'Image',
    props: { src: options.image, alt: '', fit: 'cover' },
    styles: {},
    position: { mode: 'free', x: { anchor: 'scale', start: 37.5, size: 25 }, y: { anchor: 'start', offset: 400 } },
    size: { w: { kind: 'px', v: 240 }, h: { kind: 'px', v: 160 } },
    rotation: 0,
    children: [],
  };
  return {
    schemaVersion: 1,
    root: { id: 'root', type: 'Page', props: {}, styles: {}, position: { mode: 'flow' }, children: options.image ? [textBlock, imageBlock] : [textBlock] },
    ...(options.metaImage ? { meta: { image: options.metaImage } } : {}),
  };
}
