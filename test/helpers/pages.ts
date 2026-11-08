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

// Trang mẫu có một khối Album (khối riêng của CardMaking) với các địa chỉ ảnh cho trước.
export function albumPage(images: unknown[]) {
  const page = samplePage('x');
  const album = {
    id: 'n3',
    type: 'Album',
    props: { images, autoplay: true, interval: 1.5, lightbox: true, radius: 16, dotColor: '#511419' },
    styles: {},
    position: { mode: 'free', x: { anchor: 'scale', start: 10, size: 80 }, y: { anchor: 'start', offset: 400 } },
    size: { w: { kind: 'px', v: 380 }, h: { kind: 'px', v: 360 } },
    rotation: 0,
    children: [],
  };
  return { ...page, root: { ...page.root, children: [...page.root.children, album] } };
}

// Trang mẫu có một khối Bản đồ với các thuộc tính ghi đè cho trước.
export function mapPage(props: Record<string, unknown> = {}) {
  const page = samplePage('x');
  const map = {
    id: 'n4',
    type: 'Map',
    props: { heading: 'Địa điểm', name: 'White Palace', address: '194 Hoàng Văn Thụ, Phú Nhuận', zoom: 16, button: 'Chỉ đường', color: '#511419', innerFrame: true, padding: 14, ...props },
    styles: {},
    position: { mode: 'free', x: { anchor: 'scale', start: 10, size: 80 }, y: { anchor: 'start', offset: 400 } },
    size: { w: { kind: 'px', v: 380 }, h: { kind: 'px', v: 440 } },
    rotation: 0,
    children: [],
  };
  return { ...page, root: { ...page.root, children: [...page.root.children, map] } };
}

// Trang mẫu có một khối Lịch tháng với các thuộc tính ghi đè cho trước.
export function calendarPage(props: Record<string, unknown> = {}) {
  const page = samplePage('x');
  const calendar = {
    id: 'n5',
    type: 'Calendar',
    props: { date: '2026-01-03', sundayFirst: false, showTitle: true, markShape: 'Tròn', markColor: '#511419', markTextColor: '#ffffff', color: '#511419', weekColor: '#8a5a5e', size: 16, font: '', titleFont: '', ...props },
    styles: {},
    position: { mode: 'free', x: { anchor: 'scale', start: 10, size: 80 }, y: { anchor: 'start', offset: 400 } },
    size: { w: { kind: 'px', v: 340 }, h: { kind: 'px', v: 320 } },
    rotation: 0,
    children: [],
  };
  return { ...page, root: { ...page.root, children: [...page.root.children, calendar] } };
}

// Trang mẫu có một khối thuộc loại `type` với đúng các thuộc tính mặc định của nó.
export function blockPage(type: string, props: Record<string, unknown>) {
  const page = samplePage('x');
  const block = {
    id: 'n9',
    type,
    props,
    styles: {},
    position: { mode: 'free', x: { anchor: 'scale', start: 10, size: 80 }, y: { anchor: 'start', offset: 400 } },
    size: { w: { kind: 'px', v: 340 }, h: { kind: 'px', v: 300 } },
    rotation: 0,
    children: [],
  };
  return { ...page, root: { ...page.root, children: [...page.root.children, block] } };
}
