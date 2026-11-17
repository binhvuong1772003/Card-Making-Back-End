import { Prisma } from '@prisma/client';
import { builtInRegistry, emptyPage, isPageData, newNode, validatePage, type FreeNode, type JsonValue, type NodeStyles, type PageData, type TreeNode } from '@miditor/core';
import { cardDefinitions } from '../../CMFE/lib/cards/blocks/definitions';
import { formPresets } from '../../CMFE/lib/cards/blocks/form-presets';
import { hoaMocXanhDemoDocument } from '../../CMFE/lib/cards/demos/hoa-moc-xanh';
import { minimalismNauDemoDocument } from '../../CMFE/lib/cards/demos/minimalism-nau';
import { songHyV2DoDocument } from '../../CMFE/lib/cards/demos/song-hy-v2-do';
import { toDuyenDoDamDocument } from '../../CMFE/lib/cards/demos/to-duyen-do-dam';
import { minimalismNauDamDocument } from '../../CMFE/lib/cards/demos/minimalism-nau-dam';
import { toDuyenXanhDocument } from '../../CMFE/lib/cards/demos/to-duyen-xanh';
import { camThachVangDocument } from '../../CMFE/lib/cards/demos/cam-thach-vang';
import { vuonXuanLamDocument } from '../../CMFE/lib/cards/demos/vuon-xuan-lam';
import { longPhungLamDocument } from '../../CMFE/lib/cards/demos/long-phung-lam';
import { hoangKimIiXanhDocument } from '../../CMFE/lib/cards/demos/hoang-kim-ii-xanh';
import { hoangKimIiDoDocument } from '../../CMFE/lib/cards/demos/hoang-kim-ii-do';
import { hoaTinhDoDocument } from '../../CMFE/lib/cards/demos/hoa-tinh-do';
import { hoaMocNauDocument } from '../../CMFE/lib/cards/demos/hoa-moc-nau';
import { vuonXuanDoDocument } from '../../CMFE/lib/cards/demos/vuon-xuan-do';
import { thanhDiepXanhDocument } from '../../CMFE/lib/cards/demos/thanh-diep-xanh';
import { songPhungXanhDocument } from '../../CMFE/lib/cards/demos/song-phung-xanh';
import { nhatBinhDoDocument } from '../../CMFE/lib/cards/demos/nhat-binh-do';
import { minimalismLamDamDocument } from '../../CMFE/lib/cards/demos/minimalism-lam-dam';
import { longPhungV4DoDocument } from '../../CMFE/lib/cards/demos/long-phung-v4-do';
import { lauDaiLamDocument } from '../../CMFE/lib/cards/demos/lau-dai-lam';
import { hoaRumTrangDocument } from '../../CMFE/lib/cards/demos/hoa-rum-trang';
import { hoaMocHongDocument } from '../../CMFE/lib/cards/demos/hoa-moc-hong';
import { hoaLuaNauDocument } from '../../CMFE/lib/cards/demos/hoa-lua-nau';
import { chibiRedDocument } from '../../CMFE/lib/cards/demos/chibi-red';
import { baroqueV2XanhDamDocument } from '../../CMFE/lib/cards/demos/baroque-v2-xanh-dam';
import { baroqueLamDocument } from '../../CMFE/lib/cards/demos/baroque-lam';
import { songLongXanhDocument } from '../../CMFE/lib/cards/demos/song-long-xanh';
import { longPhungXanhDocument } from '../../CMFE/lib/cards/demos/long-phung-xanh';
import { vuonXuanXanhDocument } from '../../CMFE/lib/cards/demos/vuon-xuan-xanh';
import { renTheuTrangDocument } from '../../CMFE/lib/cards/demos/ren-theu-trang';
import { minimalismDoDocument } from '../../CMFE/lib/cards/demos/minimalism-do';
import { lauDaiXanhDocument } from '../../CMFE/lib/cards/demos/lau-dai-xanh';
import { hoangKimDoDocument } from '../../CMFE/lib/cards/demos/hoang-kim-do';
import { songHacDoDocument } from '../../CMFE/lib/cards/demos/song-hac-do';
import { baroqueV2DoDamDocument } from '../../CMFE/lib/cards/demos/baroque-v2-do-dam';
import { anhDaoHongDocument } from '../../CMFE/lib/cards/demos/anh-dao-hong';
import { vuonkinhXanhDocument } from '../../CMFE/lib/cards/demos/vuonkinh-xanh';
import { vuonkinhHongDocument } from '../../CMFE/lib/cards/demos/vuonkinh-hong';
import { songLongDoDocument } from '../../CMFE/lib/cards/demos/song-long-do';
import { longPhungDoDocument } from '../../CMFE/lib/cards/demos/long-phung-do';
import { longPhungV3DoDocument } from '../../CMFE/lib/cards/demos/long-phung-v3-do';
import { songPhungDoDocument } from '../../CMFE/lib/cards/demos/song-phung-do';
import { longPhungV2DoDocument } from '../../CMFE/lib/cards/demos/long-phung-v2-do';
import { maiLanTrangDocument } from '../../CMFE/lib/cards/demos/mai-lan-trang';
import { lienHoaV2XanhDocument } from '../../CMFE/lib/cards/demos/lien-hoa-v2-xanh';
import { minimalismXanhDocument } from '../../CMFE/lib/cards/demos/minimalism-xanh';
import { normalizeCardDocument, type CardDocument, type CardPage } from '../../CMFE/lib/cards/document';
import { prisma } from '../src/infra/prisma';
import { filterPublishedSeedTargets, findMissingCatalogAssets, parseReferenceSeedArgs, selectContentHandoff, type ContentHandoffSlug } from './seed-reference-templates-mode';

type Design = {
  title: string;
  slug: string;
  family: 'minimal' | 'songhy' | 'songhy-v2' | 'botanical' | 'silk';
  palette: { primary: string; secondary: string; paper: string; ink: string; accent: string };
  ornaments: readonly string[];
  description: string;
};

const designs: Design[] = [
  { title: 'Minimalism - Đỏ Đậm', slug: 'minimalism-do-dam', family: 'minimal', palette: { primary: '#681b28', secondary: '#8e4547', paper: '#fbf3e8', ink: '#49151c', accent: '#c49b53' }, ornaments: ['ref-min-red-flower', 'ref-min-red-castle', 'ref-min-red-camera', 'ref-min-red-cake'], description: 'Phong bì đỏ burgundy lồng ảnh cưới, dấu sáp vàng hình tim, nền kem và bóng dinh thự cổ.' },
  { title: 'Minimalism - Nâu', slug: 'minimalism-nau', family: 'minimal', palette: { primary: '#563d35', secondary: '#7c6a60', paper: '#fff7f3', ink: '#563d35', accent: '#b89b71' }, ornaments: ['ref-min-brown-flower', 'ref-min-brown-leaf', 'ref-min-brown-house', 'ref-min-brown-avatar-frame', 'ref-min-brown-paper', 'ref-min-brown-paper-note', 'ref-min-brown-gate', 'ref-min-brown-cake', 'ref-min-brown-water', 'ref-min-brown-gift-main', 'ref-min-brown-gift-mini-minimalism-purple', 'ref-min-brown-gift-mini-song-hac-red', 'ref-min-brown-gift-mini-minimalism-darkred', 'ref-min-brown-gift-mini-spring-garden-blue', 'ref-min-brown-gift-mini-porcelain-brown', 'ref-min-brown-gift-mini-porcelain-v2-pink', 'ref-min-brown-gift-mini-double-dragon-red'], description: 'Thiệp cưới Minimalism Nâu với ảnh, nền giấy, hoa trang trí, lịch, sổ lưu bút và quà.' },
  { title: 'Song Hỷ - Xanh', slug: 'song-hy-xanh', family: 'songhy', palette: { primary: '#164d3c', secondary: '#2e6b54', paper: '#f8f1e3', ink: '#173d32', accent: '#d1b77b' }, ornaments: ['ref-songhy-green-emblem', 'ref-songhy-green-sunburst', 'starter-olive-branch'], description: 'Chữ 囍, phong bì xanh rừng, khung ảnh vòm và chữ cong LOVE NEVER FAILS.' },
  { title: 'Song Hỷ V2 - Đỏ', slug: 'song-hy-v2-do', family: 'songhy-v2', palette: { primary: '#a81420', secondary: '#c63739', paper: '#fff4df', ink: '#65141d', accent: '#d3ad67' }, ornaments: ['ref-songhy-red-emblem', 'ref-songhy-red-hero-shape', 'ref-songhy-red-flower', 'ref-songhy-red-ring', 'ref-songhy-red-toast', 'ref-songhy-red-cake'], description: 'Nền đỏ son, bảng giấy kem viền vàng, ảnh vòm, rèm lượn sóng và huy hiệu Song Hỷ.' },
  { title: 'Hoa Mộc - Xanh', slug: 'hoa-moc-xanh', family: 'botanical', palette: { primary: '#30530f', secondary: '#464646', paper: '#fffaf7', ink: '#30530f', accent: '#b4a17e' }, ornaments: ['starter-botanical-corners', 'starter-floral-divider', 'starter-faint-leaf-pattern'], description: 'Hoa watercolor boho trên nền kem, tông xanh lá và các cụm hoa đặt thoáng.' },
  { title: 'Tơ Duyên - Xanh', slug: 'to-duyen-xanh', family: 'silk', palette: { primary: '#53664d', secondary: '#87927a', paper: '#fffefa', ink: '#344333', accent: '#c5b78d' }, ornaments: ['starter-olive-branch', 'starter-botanical-corners', 'starter-floral-divider'], description: 'Hai ảnh nghiêng, bố cục so le, hoa rum trắng, dải lụa xanh và nét tơ mảnh.' },
  { title: 'Song Hỷ - Đỏ', slug: 'song-hy-do', family: 'songhy', palette: { primary: '#800000', secondary: '#a52a2a', paper: '#fff7eb', ink: '#800000', accent: '#fbbf24' }, ornaments: ['ref-songhy-red-emblem', 'ref-songhy-red-cloud', 'ref-songhy-red-heart', 'ref-songhy-red-ring', 'ref-songhy-red-toast', 'ref-songhy-red-cake'], description: 'Chữ Hỷ làm trung tâm, huy hiệu đỏ, phong bì Song Hỷ, khung ảnh vòm trên nền kem.' },
  { title: 'Cẩm Thạch - Vàng', slug: 'cam-thach-vang', family: 'marble', palette: { primary: '#a78555', secondary: '#d7b681', paper: '#fffdf8', ink: '#1e1e1e', accent: '#a78555' }, ornaments: [], description: 'Nền đá cẩm thạch vân vàng, lá vàng kim hai góc và bìa thẻ kem.' },
  { title: 'Liên Hoa V2 - Xanh', slug: 'lien-hoa-v2-xanh', family: 'lotus', palette: { primary: '#5e813c', secondary: '#a8c48a', paper: '#fffbed', ink: '#124d00', accent: '#f2b8c6' }, ornaments: [], description: 'Sen hồng lá xanh trên nền giấy kem.' },
  { title: 'Mai Lan - Trắng', slug: 'mai-lan-trang', family: 'minimal', palette: { primary: '#404a1d', secondary: '#5a6628', paper: '#fffaf7', ink: '#404a1d', accent: '#ffffff' }, ornaments: [], description: 'Hoa mai lan trắng trên nền xanh rêu đậm và thẻ kem.' },
  { title: 'Long Phụng V2 - Đỏ', slug: 'long-phung-v2-do', family: 'longphung', palette: { primary: '#680d0e', secondary: '#e9ce9e', paper: '#f5f0e8', ink: '#4a0808', accent: '#e9ce9e' }, ornaments: [], description: 'Thẻ đỏ sẫm có rồng phụng chìm, chữ vàng nhạt trên nền giấy trắng.' },
  { title: 'Song Phụng - Đỏ', slug: 'song-phung-do', family: 'songphung', palette: { primary: '#710001', secondary: '#530000', paper: '#fff0e7', ink: '#710001', accent: '#710001' }, ornaments: [], description: 'Đôi phụng hoàng đỏ sẫm trên thẻ kem, hoa trang trí hai góc.' },
  { title: 'Long Phụng V3 - Đỏ', slug: 'long-phung-v3-do', family: 'longphung', palette: { primary: '#710001', secondary: '#450001', paper: '#5a000e', ink: '#ffbe89', accent: '#ffbe89' }, ornaments: [], description: 'Nền đỏ thẫm, rồng phụng chìm và chữ cam vàng.' },
  { title: 'Long Phụng - Đỏ', slug: 'long-phung-do', family: 'longphung', palette: { primary: '#680e0e', secondary: '#360202', paper: '#680e0e', ink: '#e9ce9e', accent: '#e9ce9e' }, ornaments: [], description: 'Rồng phụng vàng nhạt trên nền đỏ sẫm, song ngữ Việt - Hoa.' },
  { title: 'Song Long - Đỏ', slug: 'song-long-do', family: 'songlong', palette: { primary: '#882925', secondary: '#a31d16', paper: '#ecdfd6', ink: '#464646', accent: '#f0d497' }, ornaments: [], description: 'Đôi rồng vàng chìm trên thẻ đỏ, nền hồng nhạt họa tiết rồng.' },
  { title: 'Vườn Kính - Hồng', slug: 'vuonkinh-hong', family: 'glassgarden', palette: { primary: '#cb5d6c', secondary: '#ad3f4e', paper: '#fdf6f8', ink: '#933845', accent: '#f7e3e8' }, ornaments: [], description: 'Hoa lá hồng phấn nền kính mờ, tông hồng lãng mạn.' },
  { title: 'Vườn Kính - Xanh', slug: 'vuonkinh-xanh', family: 'glassgarden', palette: { primary: '#47613e', secondary: '#294320', paper: '#fbfdf8', ink: '#35452f', accent: '#c4d4b3' }, ornaments: [], description: 'Hoa trắng và lá xanh nền kính mờ, tông xanh lãng mạn.' },
  { title: 'Ánh Đào Hồng', slug: 'anh-dao-hong', family: 'blossom', palette: { primary: '#ba4a59', secondary: '#9c2c3b', paper: '#fff5f7', ink: '#8a3a45', accent: '#f9e3e8' }, ornaments: [], description: 'Hoa anh đào hồng trên nền hồng rượu, thẻ cao có ô tên khách.' },
  { title: 'Baroque V2 - Đỏ Đậm', slug: 'baroque-v2-do-dam', family: 'baroque', palette: { primary: '#ffdfaf', secondary: '#511419', paper: '#2b0303', ink: '#ffefd6', accent: '#4a0b0e' }, ornaments: [], description: 'Khung mạ vàng nền damask đỏ đậm.' },
  { title: 'Song Hạc - Đỏ', slug: 'song-hac-do', family: 'crane', palette: { primary: '#ffe8a4', secondary: '#920002', paper: '#5a0000', ink: '#ffe8a4', accent: '#97110e' }, ornaments: [], description: 'Đôi hạc trắng trên nền đỏ son, mây vàng.' },
  { title: 'Hoàng Kim - Đỏ', slug: 'hoang-kim-do', family: 'royal', palette: { primary: '#e1bc7c', secondary: '#7a0003', paper: '#3e0001', ink: '#e1bc7c', accent: '#5a0002' }, ornaments: [], description: 'Đỏ đô và vàng đồng sang trọng, hoa văn mờ.' },
  { title: 'Lâu Đài - Xanh', slug: 'lau-dai-xanh', family: 'garden', palette: { primary: '#3a5a2c', secondary: '#5a8040', paper: '#ffffff', ink: '#3a5a2c', accent: '#eaeee8' }, ornaments: [], description: 'Vườn châu Âu màu nước, xanh rêu và hoa dại.' },
  { title: 'Minimalism - Đỏ', slug: 'minimalism-do', family: 'minimalism', palette: { primary: '#7c151a', secondary: '#5a0e12', paper: '#fffaf7', ink: '#7c151a', accent: '#f6e6e4' }, ornaments: [], description: 'Tối giản chữ thư pháp, đỏ đô và nét vẽ trái tim.' },
  { title: 'Ren Thêu - Trắng', slug: 'ren-theu-trang', family: 'lace', palette: { primary: '#1a1a1a', secondary: '#8f7964', paper: '#ffffff', ink: '#1a1a1a', accent: '#ebebeb' }, ornaments: [], description: 'Ren thêu trắng và hoa trà trên nền lụa đen.' },
  { title: 'Vườn Xuân - Xanh', slug: 'vuon-xuan-xanh', family: 'watercolor', palette: { primary: '#5d6a57', secondary: '#4a5645', paper: '#ffffff', ink: '#5d6a57', accent: '#eef0ed' }, ornaments: [], description: 'Màu nước xanh rêu nhẹ, chữ thư pháp mềm.' },
  { title: 'Long Phụng - Xanh', slug: 'long-phung-xanh', family: 'dragon', palette: { primary: '#e9ce9e', secondary: '#162614', paper: '#162614', ink: '#e9ce9e', accent: '#27341f' }, ornaments: [], description: 'Rồng phượng vàng nhạt trên nền xanh rêu đậm (bản tiếng Anh).' },
  { title: 'Song Long - Xanh', slug: 'song-long-xanh', family: 'dragon', palette: { primary: '#1f3a25', secondary: '#f0d497', paper: '#fffef7', ink: '#2c2416', accent: '#efece4' }, ornaments: [], description: 'Đôi rồng vàng trên nền xanh lục thẫm, song ngữ Việt - Hàn.' },
  { title: 'Baroque - Lam', slug: 'baroque-lam', family: 'baroque', palette: { primary: '#5e7e9b', secondary: '#b29c68', paper: '#f9f1e6', ink: '#72614b', accent: '#ece8e0' }, ornaments: [], description: 'Khung baroque vàng lam, nền kem và xanh lụa.' },
  { title: 'Baroque V2 - Xanh Đậm', slug: 'baroque-v2-xanh-dam', family: 'baroque', palette: { primary: '#ffdfaf', secondary: '#511419', paper: '#0a1a0b', ink: '#ffefd6', accent: '#122a13' }, ornaments: [], description: 'Khung mạ vàng nền damask xanh đậm.' },
  { title: 'Chibi - Đỏ', slug: 'chibi-red', family: 'chibi', palette: { primary: '#9e2a2b', secondary: '#c44d4d', paper: '#fef0e0', ink: '#4c2d1f', accent: '#f0dfd0' }, ornaments: [], description: 'Minh họa chibi cô dâu chú rể, nền kem và đỏ, ba ngôn ngữ.' },
  { title: 'Hoa Lụa - Nâu', slug: 'hoa-lua-nau', family: 'silk', palette: { primary: '#996247', secondary: '#7a4d38', paper: '#faf3e8', ink: '#996247', accent: '#f2e7db' }, ornaments: [], description: 'Hoa lụa vẽ nét trên nền kem, nâu đất ấm.' },
  { title: 'Hoa Mộc - Hồng', slug: 'hoa-moc-hong', family: 'botanical', palette: { primary: '#9d6d63', secondary: '#c4897f', paper: '#fffaf7', ink: '#9d6d63', accent: '#f7eeeb' }, ornaments: [], description: 'Hoa mộc nước hồng đào trên nền hồng rượu.' },
  { title: 'Hoa Rum - Trắng', slug: 'hoa-rum-trang', family: 'calla', palette: { primary: '#5c5f3e', secondary: '#a78555', paper: '#f4f3ee', ink: '#5c5f3e', accent: '#e8e7e0' }, ornaments: [], description: 'Hoa rum trắng nhẹ trên nền xanh olive.' },
  { title: 'Lâu Đài - Lam', slug: 'lau-dai-lam', family: 'garden', palette: { primary: '#123467', secondary: '#1a4080', paper: '#ffffff', ink: '#123467', accent: '#ecf0f3' }, ornaments: [], description: 'Lâu đài châu Âu màu nước, xanh lam đậm.' },
  { title: 'Long Phụng V4 - Đỏ', slug: 'long-phung-v4-do', family: 'longphung', palette: { primary: '#ffd390', secondary: '#8c0000', paper: '#5a0000', ink: '#ffd390', accent: '#681b0a' }, ornaments: [], description: 'Long phụng vàng trên nền đỏ son, khung tròn mạ vàng.' },
  { title: 'Minimalism - Lam Đậm', slug: 'minimalism-lam-dam', family: 'minimalism', palette: { primary: '#00224c', secondary: '#073268', paper: '#f7f5ee', ink: '#00224c', accent: '#e3e1e0' }, ornaments: [], description: 'Tối giản tông navy, hoa lam nước hai bên.' },
  { title: 'Nhật Bình - Đỏ', slug: 'nhat-binh-do', family: 'nhatbinh', palette: { primary: '#c32a29', secondary: '#542e08', paper: '#f8f3e0', ink: '#542e08', accent: '#f4e3d1' }, ornaments: [], description: 'Giấy kem, đỏ son, quạt giấy và đèn lồng, nền nâu.' },
  { title: 'Song Phụng - Xanh', slug: 'song-phung-xanh', family: 'songphung', palette: { primary: '#19472d', secondary: '#122f1e', paper: '#fff0e7', ink: '#19472d', accent: '#ece2d8' }, ornaments: [], description: 'Đôi phụng hoàng xanh rêu trên nền kem hồng.' },
  { title: 'Thanh Diệp - Xanh', slug: 'thanh-diep-xanh', family: 'leaf', palette: { primary: '#4e6439', secondary: '#3a4c2b', paper: '#ffffff', ink: '#4e6439', accent: '#f0f2ef' }, ornaments: [], description: 'Lá xanh màu nước thanh lịch, song ngữ Việt - Anh.' },
  { title: 'Vườn Xuân - Đỏ', slug: 'vuon-xuan-do', family: 'watercolor', palette: { primary: '#d25f65', secondary: '#b54b51', paper: '#ffffff', ink: '#b54b51', accent: '#fbf2f2' }, ornaments: [], description: 'Màu nước hồng đỏ, chữ thư pháp mềm.' },
  { title: 'Hoa Mộc - Nâu', slug: 'hoa-moc-nau', family: 'botanical', palette: { primary: '#4a2816', secondary: '#846758', paper: '#fffaf7', ink: '#4a2816', accent: '#f0e9e4' }, ornaments: [], description: 'Hoa mộc rustic nâu đất, thẻ cao có ô tên khách.' },
  { title: 'Họa Tình - Đỏ', slug: 'hoa-tinh-do', family: 'comic', palette: { primary: '#d70c1b', secondary: '#8b0000', paper: '#ffffff', ink: '#000000', accent: '#fbe8e9' }, ornaments: [], description: 'Nét vẽ tay trái tim, nền đỏ rực.' },
  { title: 'Hoàng Kim II - Đỏ', slug: 'hoang-kim-ii-do', family: 'royal', palette: { primary: '#e5e4d0', secondary: '#874f22', paper: '#3e0001', ink: '#e5e4d0', accent: '#4c1312' }, ornaments: [], description: 'Hoa hồng trắng ánh vàng trên nền đỏ đô, thẻ tối.' },
  { title: 'Hoàng Kim II - Xanh', slug: 'hoang-kim-ii-xanh', family: 'royal', palette: { primary: '#e5e4d0', secondary: '#874f22', paper: '#10261c', ink: '#e5e4d0', accent: '#22362b' }, ornaments: [], description: 'Hoa hồng trắng ánh vàng trên nền xanh lục thẫm.' },
  { title: 'Long Phụng - Lam', slug: 'long-phung-lam', family: 'dragon', palette: { primary: '#e9ce9e', secondary: '#0a202f', paper: '#0a202f', ink: '#e9ce9e', accent: '#1c2e38' }, ornaments: [], description: 'Rồng phượng vàng nhạt trên nền xanh lam đêm.' },
  { title: 'Vườn Xuân - Lam', slug: 'vuon-xuan-lam', family: 'watercolor', palette: { primary: '#486c7d', secondary: '#3a5666', paper: '#ffffff', ink: '#3a5666', accent: '#f0f3f4' }, ornaments: [], description: 'Màu nước xanh lam dịu, song ngữ Việt - Hàn.' },
  { title: 'Minimalism - Nâu Đậm', slug: 'minimalism-nau-dam', family: 'minimal', palette: { primary: '#513a2c', secondary: '#755742', paper: '#f7f0e4', ink: '#3c2b23', accent: '#b89456' }, ornaments: ['ref-min-brown-flower', 'ref-min-brown-water', 'ref-min-brown-cake', 'ref-min-brown-leaf'], description: 'Phong bì nâu lồng ảnh ngang, ba panel nâu chữ kem và hoa màu nước.' },
  { title: 'Tơ Duyên - Đỏ Đậm', slug: 'to-duyen-do-dam', family: 'silk', palette: { primary: '#76232d', secondary: '#a14f54', paper: '#fffdfa', ink: '#501e26', accent: '#c9a676' }, ornaments: ['ref-min-red-flower', 'starter-floral-divider', 'starter-sparkle-cluster'], description: 'Bố cục so le trên nền trắng, hoa phong quỳ đỏ, dải lụa burgundy và nét tơ.' },
  { title: 'Minimalism - Xanh', slug: 'minimalism-xanh', family: 'minimal', palette: { primary: '#536b4c', secondary: '#7d8b70', paper: '#fafbf5', ink: '#394b38', accent: '#b6a87b' }, ornaments: ['starter-olive-branch', 'starter-botanical-corners', 'starter-faint-leaf-pattern'], description: 'Hai khung polaroid, lá bạch đàn và khung vòm xanh trên nền giấy trắng.' },
];

// Only DOM-measured content exports may be added here. The generic makeDocument path is never a handoff fallback.
const contentOnlyDocuments: Partial<Record<ContentHandoffSlug, CardDocument>> = {};

function decorationSources(node: TreeNode): string[] {
  const source = node.type === 'Decoration' && typeof node.props.src === 'string' ? node.props.src : '';
  return [...(source ? [source] : []), ...node.children.flatMap(decorationSources)];
}

const registry = { ...builtInRegistry, ...cardDefinitions };
const phoneScale = 0.82;
const pageWidth = 960;
const pageHeight = 9200;
const paperHeight = 8350;
const serif = "'Cormorant Garamond', serif";
const display = "'Playfair Display', serif";
const sans = "'Montserrat', sans-serif";
const photo = (name: string) => `/demo/hoa-moc-xanh/${name}.webp`;

function node(type: string, id: string, rect: [number, number, number, number], props: Record<string, JsonValue>, styles: NodeStyles = {}, rotation = 0, phoneRect?: [number, number, number, number]): FreeNode {
  const [x, y, w, h] = rect;
  const [px, py, pw, ph] = phoneRect ?? [Math.round(x / 2.56), Math.round(y * phoneScale), Math.round(w / 2.56), Math.round(h / 2.56)];
  const result = newNode(registry, type, id, { w: pageWidth, h: pageHeight }, { props }) as FreeNode;
  result.position = { mode: 'free', x: { anchor: 'start', offset: x }, y: { anchor: 'start', offset: y } };
  result.size = { w: { kind: 'px', v: w }, h: { kind: 'px', v: h } };
  result.phone = { x: { anchor: 'start', offset: px }, y: { anchor: 'start', offset: py }, w: { kind: 'px', v: pw }, h: { kind: 'px', v: ph }, rotation };
  result.rotation = rotation;
  result.styles = { ...result.styles, ...styles };
  return result;
}

function text(id: string, value: string, rect: [number, number, number, number], palette: Design['palette'], options: { size?: number; font?: string; color?: string; bold?: boolean; italic?: boolean; align?: 'left' | 'center' | 'right'; phone?: [number, number, number, number] } = {}): FreeNode {
  const size = options.size ?? 30;
  const result = node('Text', id, rect, { text: value, size, color: options.color ?? palette.ink, font: options.font ?? serif, bold: options.bold ?? false, italic: options.italic ?? false, underline: false, align: options.align ?? 'center' }, {}, 0, options.phone);
  result.phoneProps = { size: Math.max(13, Math.round(size * 0.66)) };
  return result;
}

function shape(id: string, rect: [number, number, number, number], fill: string, kind = 'rectangle', styles: NodeStyles = {}, phone?: [number, number, number, number]): FreeNode {
  return node('Shape', id, rect, { shape: kind, fill }, styles, 0, phone);
}

function image(id: string, rect: [number, number, number, number], src: string, fit = 'contain', styles: NodeStyles = {}, rotation = 0, phone?: [number, number, number, number]): FreeNode {
  return node('Image', id, rect, { src, alt: '', fit }, styles, rotation, phone);
}

function decoration(id: string, rect: [number, number, number, number], src: string, phone?: [number, number, number, number], rotation = 0, motion = false): FreeNode {
  return node('Decoration', id, rect, { src, alt: '', fit: 'contain', motion }, {}, rotation, phone);
}

function centeredPanel(nodes: TreeNode[], item: Design, id: string, title: string, copy: string, y: number, height = 530) {
  const p = item.palette;
  const panel = item.family === 'minimal' || item.family === 'songhy-v2' ? p.primary : p.paper;
  const ink = item.family === 'minimal' || item.family === 'songhy-v2' ? p.paper : p.ink;
  nodes.push(shape(`${id}-panel`, [60, y, 840, height], panel, 'rectangle', { borderRadius: item.family === 'songhy-v2' ? 30 : 14, borderWidth: 1, borderColor: p.accent, opacity: 96 }, [10, Math.round(y * phoneScale), 355, Math.round(height / 2.55)]));
  nodes.push(text(`${id}-title`, title, [100, y + 45, 760, 68], p, { size: 38, color: ink, font: display, bold: true, phone: [22, Math.round(y * phoneScale + 18), 330, 54] }));
  nodes.push(text(`${id}-copy`, copy, [140, y + 145, 680, height - 175], p, { size: 27, color: ink, phone: [33, Math.round(y * phoneScale + 78), 309, Math.round((height - 175) / 2.4)] }));
}

function makeHero(nodes: TreeNode[], item: Design, assets: Map<string, string>) {
  const p = item.palette;
  if (item.slug === 'minimalism-do-dam') {
    const flower = assets.get('ref-min-red-flower');
    const panel = shape('hero-card-panel', [180, 240, 600, 420], '#f8f1e9', 'rectangle', {
      borderRadius: 8,
      shadow: { x: 0, y: 20, blur: 42, spread: 0, color: '#21080a', opacity: 34 },
    }, [20, 166, 335, 480]);
    nodes.push(shape('hero-card-background', [0, 0, 960, 900], '#611820', 'rectangle', {}, [0, 0, 375, 812]));
    nodes.push(panel);
    if (flower) {
      nodes.push(decoration('hero-card-flower-left', [180, 255, 150, 235], flower, [20, 206, 82, 178]));
      nodes.push(decoration('hero-card-flower-right', [630, 255, 150, 235], flower, [273, 206, 82, 178]));
    }
    nodes.push(shape('hero-card-heart-disc', [438, 252, 84, 84], '#5c1017', 'ellipse', {}, [158, 184, 59, 59]));
    nodes.push(text('hero-card-heart', '♥', [454, 267, 52, 52], p, {
      size: 32, color: '#fff3e9', font: "'Cormorant Garamond', serif", bold: true,
      phone: [169, 194, 37, 38],
    }));
    nodes.push(text('hero-card-names', 'Hoàng Long\n&\nBảo Ngọc', [315, 330, 330, 110], p, {
      size: 43, color: '#681b28', font: "'Cormorant Garamond', serif", phone: [47, 268, 281, 119],
    }));
    nodes.push(shape('hero-card-divider-left', [326, 451, 78, 1], '#a66b61', 'rectangle', {}, [79, 401, 58, 1]));
    nodes.push(text('hero-card-divider-mark', '❧', [448, 442, 64, 22], p, {
      size: 16, color: '#8d4b4a', font: "'Cormorant Garamond', serif", phone: [169, 394, 37, 19],
    }));
    nodes.push(shape('hero-card-divider-right', [556, 451, 78, 1], '#a66b61', 'rectangle', {}, [238, 401, 58, 1]));
    nodes.push(text('hero-card-date', '3 tháng 1, 2026', [320, 469, 320, 34], p, {
      size: 22, color: '#8a4b4c', font: "'Cormorant Garamond', serif", phone: [52, 419, 271, 30],
    }));
    nodes.push(text('hero-card-invite', 'Thân Mời', [350, 514, 260, 32], p, {
      size: 20, color: '#8a4b4c', font: "'Cormorant Garamond', serif", phone: [73, 463, 229, 30],
    }));
    nodes.push(shape('hero-card-open-button', [400, 558, 160, 48], '#681b28', 'pill', {}, [107, 518, 160, 48]));
    const open = text('hero-card-open-label', 'Mở thiệp', [400, 558, 160, 48], p, {
      size: 18, color: '#fff8f1', font: "'Cormorant Garamond', serif", bold: true, phone: [107, 518, 160, 48],
    });
    open.props.motionTarget = 'hero-card';
    nodes.push(open);
    for (const [id, rect, color, size, phoneRect] of [
      ['hero-card-heart-float-1', [92, 40, 22, 24], '#a33b43', 18, [33, 34, 10, 12]],
      ['hero-card-heart-float-2', [330, 28, 25, 28], '#a33b43', 21, [128, 80, 11, 13]],
      ['hero-card-heart-float-3', [805, 20, 22, 24], '#c18b4c', 18, [322, 126, 9, 11]],
      ['hero-card-heart-float-4', [882, 104, 18, 20], '#b17c46', 15, [334, 77, 9, 10]],
      ['hero-card-heart-float-5', [168, 407, 24, 26], '#d5c1b4', 20, [22, 514, 12, 12]],
      ['hero-card-heart-float-6', [666, 386, 19, 21], '#c18b4c', 16, [344, 503, 9, 10]],
      ['hero-card-heart-float-7', [260, 680, 24, 26], '#b27b45', 20, [94, 718, 11, 12]],
    ] as const) {
      const ornament = text(id, '♥', rect, p, { size, color, font: "'Cormorant Garamond', serif", phone: phoneRect });
      ornament.styles = { ...ornament.styles, opacity: 62 };
      nodes.push(ornament);
    }
    return;
  }

  if (item.family === 'songhy' || item.family === 'songhy-v2') {
    const panelColor = item.family === 'songhy-v2' ? p.paper : p.primary;
    nodes.push(shape('hero-banner', [0, 0, 960, 1120], panelColor, 'rectangle', { borderRadius: item.family === 'songhy-v2' ? 0 : 0 }, [0, 0, 375, 900]));
    const emblem = assets.get(item.ornaments[0]!);
    if (emblem) nodes.push(decoration('hero-emblem', [400, 58, 160, 160], emblem, [153, 24, 68, 68]));
    nodes.push(text('hero-title', '囍', [420, 70, 120, 120], p, { size: 94, color: item.family === 'songhy-v2' ? p.primary : p.paper, font: serif, bold: true, phone: [150, 28, 75, 78] }));
    nodes.push(text('hero-label', item.family === 'songhy-v2' ? 'TRUNG HIẾU   ·   THANH HÀ' : 'WELCOME TO OUR WEDDING', [100, 250, 760, 46], p, { size: 23, color: item.family === 'songhy-v2' ? p.primary : p.paper, font: sans, bold: true }));
    nodes.push(text('hero-names', 'Gia Huy  &  Ngọc Anh', [100, 305, 760, 70], p, { size: 47, color: item.family === 'songhy-v2' ? p.ink : p.paper, font: display, italic: true }));
    if (item.family === 'songhy-v2') nodes.push(shape('hero-paper-frame', [180, 360, 600, 680], p.paper, 'rectangle', { borderWidth: 2, borderColor: p.accent, borderRadius: 32 }));
    const shapeValue = 'arch';
    nodes.push(node('PhotoFrame', 'hero-couple', [275, 425, 410, 510], { src: photo('photo-1'), alt: 'Ảnh cưới minh hoạ', shape: shapeValue, frameWidth: 10, frameColor: p.accent, zoom: 100, posX: 50, posY: 50 }, { borderRadius: 0 }, 0, [77, 350, 220, 315]));
    if (item.family === 'songhy') nodes.push(text('hero-curved-copy', 'LOVE NEVER FAILS', [280, 390, 400, 38], p, { size: 18, color: p.paper, font: display, italic: true }));
    nodes.push(text('hero-date', 'THÂN MỜI  ·  22.11.2026', [160, 990, 640, 58], p, { size: 24, color: item.family === 'songhy-v2' ? p.ink : p.paper, font: sans }));
    return;
  }

  if (item.family === 'silk') {
    nodes.push(shape('hero-paper', [0, 0, 960, 1120], p.paper));
    nodes.push(decoration('hero-botanical', [30, 90, 190, 360], assets.get(item.ornaments[0]!) ?? '', [5, 50, 75, 165], -8));
    nodes.push(image('hero-groom', [265, 130, 270, 370], photo('groom'), 'cover', { borderWidth: 10, borderColor: p.paper, borderRadius: 2 }, -8, [30, 60, 150, 205]));
    nodes.push(image('hero-bride', [440, 250, 270, 370], photo('bride'), 'cover', { borderWidth: 10, borderColor: p.paper, borderRadius: 2 }, 8, [194, 155, 150, 205]));
    nodes.push(text('hero-names', 'Gia Huy  &  Ngọc Anh', [110, 690, 740, 120], p, { size: 52, color: p.primary, font: display, italic: true }));
    nodes.push(text('hero-subtitle', item.title.toUpperCase(), [200, 825, 560, 42], p, { size: 20, color: p.secondary, font: sans }));
    const ribbon = assets.get(item.ornaments[2]!);
    if (ribbon) nodes.push(decoration('hero-ribbon', [0, 950, 960, 120], ribbon, [0, 770, 375, 60]));
    return;
  }

  if (item.family === 'botanical') {
    nodes.push(shape('hero-paper', [0, 0, 960, 1120], p.paper));
    const flowers = assets.get(item.ornaments[0]!);
    if (flowers) {
      nodes.push(decoration('hero-botanical-left', [0, 20, 250, 290], flowers, [0, 10, 105, 130], -10));
      nodes.push(decoration('hero-botanical-right', [700, 710, 240, 300], flowers, [275, 540, 95, 125], 165));
    }
    nodes.push(text('hero-kicker', 'HẸN NHAU TRONG MỘT NGÀY THẬT ĐẸP', [120, 90, 720, 45], p, { size: 22, color: p.secondary, italic: true }));
    nodes.push(image('hero-couple', [270, 180, 420, 490], photo('photo-1'), 'cover', { borderWidth: 5, borderColor: p.paper, borderRadius: 220 }, 0, [74, 100, 227, 270]));
    nodes.push(text('hero-names', 'Gia Huy  &  Ngọc Anh', [120, 700, 720, 100], p, { size: 58, font: display }));
    nodes.push(text('hero-date', 'THÂN MỜI  ·  22.11.2026', [180, 850, 600, 50], p, { size: 22, color: p.secondary, font: sans }));
    const band = assets.get(item.ornaments[1]!);
    if (band) nodes.push(decoration('hero-floral-divider', [0, 980, 960, 110], band, [0, 805, 375, 64]));
    return;
  }

  nodes.push(shape('hero-paper', [0, 0, 960, 1130], p.paper));
  const architecture = assets.get(item.ornaments[1]!);
  if (architecture) nodes.push(decoration('hero-architecture', [0, 470, 960, 610], architecture, [0, 400, 375, 370]));
  const flower = assets.get(item.ornaments[0]!);
  if (flower) {
    nodes.push(decoration('hero-flower-left', [115, 265, 185, 290], flower, [37, 175, 80, 155], -8));
    nodes.push(decoration('hero-flower-right', [660, 420, 170, 240], flower, [260, 260, 76, 130], 12));
  }
  nodes.push(text('hero-date-label', 'SAVE THE DATE', [150, 55, 660, 42], p, { size: 24, color: p.primary, font: sans, bold: true }));
  const brownPolaroid = item.slug === 'minimalism-nau';
  const greenPair = item.slug === 'minimalism-xanh';
  const photoRect: [number, number, number, number] = brownPolaroid ? [315, 130, 330, 430] : greenPair ? [350, 190, 260, 330] : item.slug === 'minimalism-nau-dam' ? [330, 245, 300, 230] : [348, 130, 270, 350];
  if (brownPolaroid) {
    nodes.push(shape('hero-polaroid', [285, 145, 390, 520], '#fffdf7', 'rectangle', { shadow: { x: 0, y: 10, blur: 25, spread: 0, color: '#4a3d30', opacity: 18 } }, [86, 115, 203, 280]));
    nodes.push(shape('hero-washi-tape', [420, 120, 125, 34], '#d5c09b', 'rectangle', {}, [144, 104, 66, 18]));
  } else {
    const envelopeY = item.slug === 'minimalism-nau-dam' ? 220 : 200;
    const envelopeH = item.slug === 'minimalism-nau-dam' ? 340 : 395;
    nodes.push(shape('hero-envelope', [252, envelopeY, 456, envelopeH], p.primary, 'rectangle', { borderRadius: 5, shadow: { x: 0, y: 18, blur: 35, spread: 0, color: '#35271f', opacity: 20 } }, [78, 160, 220, 210]));
  }
  nodes.push(image('hero-photo', photoRect, photo('photo-1'), 'cover', { borderWidth: brownPolaroid ? 18 : 14, borderColor: '#fffdf7', borderRadius: 2 }, brownPolaroid ? -6 : greenPair ? -7 : 7, brownPolaroid ? [96, 120, 170, 240] : undefined));
  if (greenPair) nodes.push(image('hero-photo-second', [465, 310, 250, 335], photo('photo-2'), 'cover', { borderWidth: 14, borderColor: '#fffdf7', borderRadius: 2 }, 8, [160, 220, 165, 225]));
  if (!brownPolaroid) {
    const flapY = item.slug === 'minimalism-nau-dam' ? 425 : 400;
    nodes.push(shape('hero-envelope-flap', [295, flapY, 370, 198], p.primary, 'triangle', {}, [99, 290, 177, 90]));
  }
  nodes.push(shape('hero-wax-seal', [438, 500, 84, 84], p.accent, 'ellipse', { borderWidth: 2, borderColor: '#f5dfaa' }, [158, 330, 45, 45]));
  nodes.push(text('hero-wax-heart', '♡', [446, 496, 68, 74], p, { size: 54, color: p.paper, font: serif, bold: true, phone: [161, 328, 39, 40] }));
  nodes.push(text('hero-names', item.slug === 'minimalism-do-dam' ? 'Hoàng Long\nBảo Ngọc' : 'Gia Huy  &  Ngọc Anh', [120, 650, 720, item.slug === 'minimalism-do-dam' ? 160 : 120], p, { size: 62, color: p.primary, font: display, phone: item.slug === 'minimalism-do-dam' ? [38, 520, 299, 110] : undefined }));
  nodes.push(text('hero-date', item.slug === 'minimalism-do-dam' ? 'THÂN MỜI  ·  03.01.2026' : 'THÂN MỜI  ·  22.11.2026', [180, 810, 600, 50], p, { size: 22, color: p.secondary, font: sans }));
}

function makeDocument(item: Design, assets: Map<string, string>): CardDocument {
  const nodes: TreeNode[] = [];
  makeHero(nodes, item, assets);
  const p = item.palette;
  const sourceSample = item.slug === 'minimalism-do-dam';
  const weddingDate = sourceSample ? '2026-01-03' : '2026-11-22';
  const ceremonyY = 1250;
  const familyDetails = item.slug === 'minimalism-do-dam'
    ? 'GIA ĐÌNH NHÀ TRAI\nÔng Đặng Văn Thắng\nBà Bùi Thị Mai · Quận 1\n\nGIA ĐÌNH NHÀ GÁI\nÔng Vũ Đức Trung\nBà Ngô Thị Hạnh · Quận 3'
    : 'GIA ĐÌNH NHÀ TRAI\nÔng Trần Minh Đức · Bà Lê Thanh Mai\n\nGIA ĐÌNH NHÀ GÁI\nÔng Nguyễn Hoài Nam · Bà Phạm Thu Hương';
  centeredPanel(nodes, item, 'families', 'THÔNG TIN HAI GIA ĐÌNH', familyDetails, ceremonyY, 560);
  centeredPanel(nodes, item, 'ceremony', 'LỄ THÀNH HÔN', sourceSample ? 'Trân trọng kính mời bạn đến chung vui\n\n09:00 · Thứ Bảy, ngày 03 tháng 01 năm 2026\nTư gia' : 'Trân trọng kính mời bạn đến chung vui\n\n09:00 · Chủ nhật, ngày 22 tháng 11 năm 2026\nTư gia hai bên gia đình', 1900, 600);
  nodes.push(text('album-heading', 'ALBUM ẢNH CƯỚI', [90, 2640, 780, 70], p, { size: 40, color: p.primary, font: display, bold: true }));
  nodes.push(node('Album', 'wedding-album', [95, 2730, 770, 500], { images: Array.from({ length: 8 }, (_, i) => photo(`photo-${i + 1}`)), autoplay: false, interval: 3, lightbox: true, radius: 12, dotColor: p.primary }, { borderRadius: 12 }, 0, [15, 2155, 345, 310]));
  nodes.push(text('party-heading', 'TIỆC CƯỚI', [100, 3350, 760, 65], p, { size: 40, color: p.primary, font: display, bold: true }));
  nodes.push(text('party-copy', sourceSample ? 'Đón khách 17:30  ·  Khai tiệc 18:00\nThứ Bảy · 03.01.2026' : 'Đón khách 17:30  ·  Khai tiệc 18:00\nChủ nhật · 22.11.2026', [150, 3430, 660, 120], p, { size: 29, color: p.ink }));
  nodes.push(node(item.family === 'minimal' ? 'CalendarDark' : 'CalendarHeart', 'wedding-calendar', [290, 3600, 380, 350], { date: weddingDate, color: p.primary, weekColor: p.secondary, markColor: p.primary, markTextColor: p.paper, size: 19, font: serif, titleFont: display, eventButton: 'Thêm vào lịch', eventTitle: `Lễ cưới Gia Huy & Ngọc Anh`, eventTime: '18:00' }, { background: p.paper, borderRadius: 12 }, 0, [38, 2940, 299, 285]));
  nodes.push(node('Map', 'wedding-map', [145, 4050, 670, 520], { name: 'White Palace', address: '194 Hoàng Văn Thụ, TP. Hồ Chí Minh', heading: 'ĐỊA ĐIỂM TIỆC CƯỚI', button: 'Chỉ đường', color: p.primary, innerFrame: true, padding: 16 }, { borderRadius: 10 }, 0, [20, 3300, 335, 430]));
  nodes.push(text('dress-heading', 'DRESS CODE', [170, 4700, 620, 70], p, { size: 40, color: p.primary, font: display, bold: true }));
  nodes.push(node('DressCode', 'dress-code', [300, 4790, 360, 250], { heading: 'DRESS CODE', subtitle: 'Trang phục dự tiệc', headingColor: p.primary, subtitleColor: p.secondary, colors: [p.primary, p.secondary, p.accent, p.paper], swatchShape: 'circle', swatchSize: 44, swatchGap: 18 }, {}, 0, [20, 3840, 335, 205]));
  centeredPanel(nodes, item, 'timeline', 'LỊCH TRÌNH NGÀY CƯỚI', '17:30  ·  Đón khách\n18:00  ·  Khai tiệc\n18:30  ·  Nghi thức cưới\n19:00  ·  Cắt bánh & nâng ly', 5150, 620);
  const rsvp = formPresets.find(({ id }) => id === 'attendance')!;
  nodes.push(node('Form', 'wedding-rsvp', [170, 5900, 620, 500], { ...rsvp.props, formId: `rsvp-${item.slug}`, heading: 'BẠN SẼ ĐẾN CHỨ?', intro: 'Gia Huy và Ngọc Anh rất mong được đón bạn.', color: p.primary }, { background: p.paper, borderWidth: 1, borderColor: p.accent, borderRadius: 12 }, 0, [18, 4720, 339, 420]));
  const wishes = formPresets.find(({ id }) => id === 'wishes')!;
  nodes.push(node('Form', 'wedding-wishes', [170, 6520, 620, 540], { ...wishes.props, formId: `wishes-${item.slug}`, heading: 'SỔ LƯU BÚT', intro: 'Gửi đôi lời chúc mừng tới cô dâu chú rể.', color: p.primary }, { background: p.paper, borderWidth: 1, borderColor: p.accent, borderRadius: 12 }, 0, [18, 5240, 339, 440]));
  const gift = assets.get('starter-wedding-gift-box');
  if (gift) nodes.push(decoration('wedding-gift', [390, 7240, 180, 185], gift, [135, 5850, 105, 115], 0, true));
  nodes.push(text('thank-you', 'SỰ HIỆN DIỆN CỦA BẠN LÀ NIỀM VUI CỦA CHÚNG MÌNH', [100, 7480, 760, 100], p, { size: 27, color: p.primary, font: display }));

  const bg = item.family === 'songhy' ? p.paper : p.paper;
  const data: PageData = { ...emptyPage(), root: { ...emptyPage().root, styles: { background: bg, minHeight: pageHeight, phoneMinHeight: 7600 }, children: nodes }, theme: { colors: { primary: p.primary, secondary: p.secondary, paper: p.paper }, fonts: { body: serif, heading: display } }, meta: { title: `${item.title} · Gia Huy & Ngọc Anh`, description: item.description } };
  const popupNodes: TreeNode[] = [
    text('gift-popup-title', 'MỪNG CƯỚI', [100, 70, 760, 75], p, { size: 45, color: p.primary, font: display, bold: true },),
    text('gift-popup-copy', 'Cảm ơn bạn đã chung vui cùng chúng mình', [100, 155, 760, 55], p, { size: 25, color: p.ink }),
    image('gift-popup-qr', [370, 245, 220, 220], '/demo/hoa-moc-xanh/qr-minh-hoa.svg', 'contain', { borderWidth: 1, borderColor: p.accent, borderRadius: 12 }),
    text('gift-popup-bank', 'MÃ QR MINH HOẠ\n\nTên người nhận: Gia Huy & Ngọc Anh\nSố tài khoản: 0000 0000 0000', [150, 500, 660, 210], p, { size: 25, color: p.ink }),
  ];
  const popupData: PageData = { ...emptyPage(), root: { ...emptyPage().root, styles: { background: p.paper, minHeight: 900, phoneMinHeight: 800 }, children: popupNodes }, theme: data.theme };
  const popup: CardPage = { id: 'gift-details', name: 'Mừng cưới', data: popupData, interactions: {}, popup: { width: 640, effect: 'fade', backdropColor: p.primary, backdropOpacity: 58 } };
  const invitation: CardPage = { id: 'invitation', name: 'Thiệp mời', data, interactions: { 'wedding-gift': { type: 'open-popup', targetPageId: popup.id, transition: 'fade', durationMs: 350 } } };

  if (item.slug !== 'minimalism-do-dam') return { kind: 'card', version: 1, startPageId: invitation.id, pages: [invitation, popup] };

  // The first page is a full-screen welcome card; the invitation body stays on its own page.
  const coverNodes = nodes.filter(({ id }) => id.startsWith('hero-'));
  const openOnTap = ['hero-card-open-label'];
  const coverData: PageData = {
    ...emptyPage(),
    root: { ...emptyPage().root, styles: { background: '#611820', minHeight: 900, phoneMinHeight: 812 }, children: coverNodes },
    theme: data.theme,
    meta: data.meta,
  };
  const shiftAxis = (axis: FreeNode['position']['y'], amount: number): FreeNode['position']['y'] => {
    if (axis.anchor === 'stretch') return { ...axis, start: axis.start + amount, end: axis.end - amount };
    if (axis.anchor === 'scale') return { ...axis, start: axis.start + amount };
    return { ...axis, offset: axis.offset + amount };
  };
  const shiftBodyNode = (child: TreeNode): TreeNode => {
    const next = { ...child } as FreeNode;
    if (next.position?.mode === 'free') next.position = { ...next.position, y: shiftAxis(next.position.y, -1120) };
    if (next.phone) next.phone = { ...next.phone, y: shiftAxis(next.phone.y, -920) };
    return next;
  };
  const invitationData: PageData = {
    ...data,
    root: { ...data.root, styles: { ...data.root.styles, minHeight: 6600, phoneMinHeight: 5400 }, children: nodes.filter(({ id }) => !id.startsWith('hero-')).map(shiftBodyNode) },
  };
  const cover: CardPage = {
    id: 'cover',
    name: 'Bìa thiệp',
    data: coverData,
    interactions: Object.fromEntries(openOnTap.map((id) => [id, { type: 'go-to-page', targetPageId: invitation.id, transition: 'zoom', durationMs: 650 }])),
  };
  invitation.data = invitationData;
  const document: CardDocument = { kind: 'card', version: 1, startPageId: cover.id, pages: [cover, invitation, popup] };
  if (sourceSample) {
    const replaceNames = (value: JsonValue): JsonValue => {
      if (typeof value === 'string') return value.replaceAll('Gia Huy', 'Hoàng Long').replaceAll('Ngọc Anh', 'Bảo Ngọc');
      if (Array.isArray(value)) return value.map(replaceNames);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replaceNames(entry)]));
      return value;
    };
    const updateNames = (child: TreeNode): TreeNode => ({ ...child, props: replaceNames(child.props) as Record<string, JsonValue>, children: child.children.map(updateNames) });
    for (const page of document.pages) {
      page.data = { ...page.data, root: { ...page.data.root, children: page.data.root.children.map(updateNames) }, meta: { ...page.data.meta, title: `${item.title} · Hoàng Long & Bảo Ngọc` } };
    }
  }
  return document;
}

async function main() {
  const options = parseReferenceSeedArgs(process.argv.slice(2));
  if (options.mode === 'content-handoff') {
    const item = designs.find(({ slug }) => slug === options.slug);
    const document = contentOnlyDocuments[options.slug];
    if (!item) throw new Error(`Unknown template slug: ${options.slug}`);
    if (!document) throw new Error(`${options.slug} has no DOM-measured content-only export yet; refusing generic makeDocument fallback.`);
    if (document.kind !== 'card' || document.startPageId !== 'invitation' || document.pages.length !== 1 || document.pages[0]?.id !== 'invitation') {
      throw new Error(`${options.slug} must export exactly one start page named invitation.`);
    }
    const invitation = document.pages[0];
    if (!invitation || Object.keys(invitation.interactions).length) throw new Error(`${options.slug} content handoff must not contain cover/popup page interactions.`);
    if (!isPageData(invitation.data)) throw new Error(`${options.slug}/invitation is not valid page data.`);
    const issues = validatePage(registry, invitation.data);
    if (issues.length) throw new Error(`${options.slug}/invitation: ${JSON.stringify(issues)}`);
    const decorationUrls = decorationSources(invitation.data.root);
    if (decorationUrls.length) {
      const catalog = await prisma.decorativeAsset.findMany({ where: { status: 'PUBLISHED' }, select: { url: true } });
      const missingAssets = findMissingCatalogAssets(decorationUrls, catalog.map(({ url }) => url));
      if (missingAssets.length) throw new Error(`${options.slug} has decorations missing from the published catalog: ${missingAssets.join(', ')}`);
    }
    const snapshot = normalizeCardDocument(document) as unknown as Prisma.InputJsonObject;
    const existing = await prisma.template.findMany({
      where: { status: 'UNLISTED', tags: { has: 'clone-content-draft' } },
      select: { id: true, status: true, tags: true },
    });
    const targetId = selectContentHandoff(existing, options.slug);
    const data = {
      title: item.title,
      description: `Nội dung thiệp đang chờ Claude hoàn thiện. Nguồn: https://chungdoi.com/vi/mau-thiep/${item.slug}/demo`,
      category: 'WEDDING',
      tags: [item.family, item.slug, 'clone-content-draft'],
      snapshot,
      version: 1,
      status: 'UNLISTED' as const,
      publishedAt: null,
    };
    if (options.dryRun) {
      process.stdout.write(`${JSON.stringify({ mode: options.mode, slug: options.slug, status: 'UNLISTED', operation: targetId ? 'update' : 'create', targetId, pages: document.pages.map(({ id }) => id), catalogDecorations: decorationUrls.length }, null, 2)}\n`);
      return;
    }
    if (targetId) await prisma.template.update({ where: { id: targetId }, data });
    else await prisma.template.create({ data });
    process.stdout.write(`Saved ${options.slug} as UNLISTED content handoff${targetId ? ` (${targetId})` : ''}. Published templates were not changed.\n`);
    return;
  }

  const slugFilter = options.slug;
  const selectedDesigns = slugFilter ? designs.filter(({ slug }) => slug === slugFilter) : designs;
  if (!selectedDesigns.length) throw new Error(`Unknown template slug: ${slugFilter}`);
  const rows = await prisma.decorativeAsset.findMany({ where: { status: 'PUBLISHED' }, select: { publicId: true, url: true } });
  const assets = new Map(rows.map(({ publicId, url }) => [publicId.split('/').at(-1)!, url]));
  const snapshots = selectedDesigns.map((item) => {
    const missing = item.ornaments.filter((assetId) => !assets.has(assetId));
    if (missing.length) throw new Error(`${item.title} đang thiếu trang trí trong MongoDB: ${missing.join(', ')}`);
    const document = item.slug === 'hoa-moc-xanh' ? hoaMocXanhDemoDocument : item.slug === 'minimalism-nau' ? minimalismNauDemoDocument : item.slug === 'song-hy-v2-do' ? songHyV2DoDocument : item.slug === 'to-duyen-do-dam' ? toDuyenDoDamDocument : item.slug === 'minimalism-nau-dam' ? minimalismNauDamDocument : item.slug === 'to-duyen-xanh' ? toDuyenXanhDocument : item.slug === 'cam-thach-vang' ? camThachVangDocument : item.slug === 'vuon-xuan-lam' ? vuonXuanLamDocument : item.slug === 'long-phung-lam' ? longPhungLamDocument : item.slug === 'hoang-kim-ii-xanh' ? hoangKimIiXanhDocument : item.slug === 'hoang-kim-ii-do' ? hoangKimIiDoDocument : item.slug === 'hoa-tinh-do' ? hoaTinhDoDocument : item.slug === 'hoa-moc-nau' ? hoaMocNauDocument : item.slug === 'vuon-xuan-do' ? vuonXuanDoDocument : item.slug === 'thanh-diep-xanh' ? thanhDiepXanhDocument : item.slug === 'song-phung-xanh' ? songPhungXanhDocument : item.slug === 'nhat-binh-do' ? nhatBinhDoDocument : item.slug === 'minimalism-lam-dam' ? minimalismLamDamDocument : item.slug === 'long-phung-v4-do' ? longPhungV4DoDocument : item.slug === 'lau-dai-lam' ? lauDaiLamDocument : item.slug === 'hoa-rum-trang' ? hoaRumTrangDocument : item.slug === 'hoa-moc-hong' ? hoaMocHongDocument : item.slug === 'hoa-lua-nau' ? hoaLuaNauDocument : item.slug === 'chibi-red' ? chibiRedDocument : item.slug === 'baroque-v2-xanh-dam' ? baroqueV2XanhDamDocument : item.slug === 'baroque-lam' ? baroqueLamDocument : item.slug === 'song-long-xanh' ? songLongXanhDocument : item.slug === 'long-phung-xanh' ? longPhungXanhDocument : item.slug === 'vuon-xuan-xanh' ? vuonXuanXanhDocument : item.slug === 'ren-theu-trang' ? renTheuTrangDocument : item.slug === 'minimalism-do' ? minimalismDoDocument : item.slug === 'lau-dai-xanh' ? lauDaiXanhDocument : item.slug === 'hoang-kim-do' ? hoangKimDoDocument : item.slug === 'song-hac-do' ? songHacDoDocument : item.slug === 'baroque-v2-do-dam' ? baroqueV2DoDamDocument : item.slug === 'anh-dao-hong' ? anhDaoHongDocument : item.slug === 'vuonkinh-xanh' ? vuonkinhXanhDocument : item.slug === 'vuonkinh-hong' ? vuonkinhHongDocument : item.slug === 'song-long-do' ? songLongDoDocument : item.slug === 'long-phung-do' ? longPhungDoDocument : item.slug === 'long-phung-v3-do' ? longPhungV3DoDocument : item.slug === 'song-phung-do' ? songPhungDoDocument : item.slug === 'long-phung-v2-do' ? longPhungV2DoDocument : item.slug === 'mai-lan-trang' ? maiLanTrangDocument : item.slug === 'lien-hoa-v2-xanh' ? lienHoaV2XanhDocument : item.slug === 'minimalism-xanh' ? minimalismXanhDocument : makeDocument(item, assets);
    for (const page of document.pages) {
      if (!isPageData(page.data)) {
        const children = page.data.root.children;
        const index = children.findIndex((_, childIndex) => !isPageData({ ...page.data, root: { ...page.data.root, children: children.slice(0, childIndex + 1) } }));
        const bad = children[index];
        throw new Error(`${item.slug}/${page.id}: invalid ${bad?.id ?? 'page root'}: ${JSON.stringify(bad ? { type: bad.type, props: bad.props, styles: bad.styles, position: bad.position, size: (bad as FreeNode).size, phone: (bad as FreeNode).phone } : { styles: page.data.root.styles, theme: page.data.theme, meta: page.data.meta })}`);
      }
      const issues = validatePage(registry, page.data);
      if (issues.length) throw new Error(`${item.slug}/${page.id}: ${JSON.stringify(issues)}`);
    }
    return normalizeCardDocument(document);
  });
  const now = Date.now();
  for (const [index, item] of selectedDesigns.entries()) {
    const description = `Bản dựng riêng theo mẫu Chung Đôi ${item.slug}. ${item.description}`;
    const existing = filterPublishedSeedTargets(await prisma.template.findMany({ where: { title: item.title, tags: { has: item.slug } }, select: { id: true, tags: true }, orderBy: { createdAt: 'asc' } }));
    const data = {
      title: item.title, description, category: 'WEDDING', tags: [item.family, item.slug],
      snapshot: snapshots[index] as unknown as Prisma.InputJsonObject,
      version: 1, status: 'PUBLISHED' as const, publishedAt: new Date(now - index * 1000),
    };
    if (existing.length) {
      await prisma.template.update({ where: { id: existing[0]!.id }, data });
      if (existing.length > 1) await prisma.template.deleteMany({ where: { id: { in: existing.slice(1).map(({ id }) => id) } } });
    } else await prisma.template.create({ data });
  }
  process.stdout.write(`Seeded ${selectedDesigns.length} source-specific wedding drafts using ${rows.length} catalog decorations.\n`);
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
