// ═══════════════════════════════════════════════════════════
// LATAIF — Internationalization (i18n)
// English + Arabic with RTL support
// ═══════════════════════════════════════════════════════════

export type Language = 'en' | 'ar';

const STORAGE_KEY = 'lataif_language';

let currentLang: Language = (localStorage.getItem(STORAGE_KEY) as Language) || 'en';
const listeners: ((lang: Language) => void)[] = [];

export function getLanguage(): Language {
  return currentLang;
}

export function setLanguage(lang: Language) {
  currentLang = lang;
  localStorage.setItem(STORAGE_KEY, lang);
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  document.documentElement.lang = lang;
  listeners.forEach(fn => fn(lang));
}

export function onLanguageChange(fn: (lang: Language) => void): () => void {
  listeners.push(fn);
  return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
}

export function isRTL(): boolean {
  return currentLang === 'ar';
}

// ── Translation dictionary ──

const translations: Record<Language, Record<string, string>> = {
  en: {
    // Navigation
    'nav.dashboard': 'Dashboard',
    'nav.clients': 'Clients',
    'nav.collection': 'Collection',
    'nav.offers': 'Offers',
    'nav.invoices': 'Invoices',
    'nav.orders': 'Orders',
    'nav.repairs': 'Repairs',
    'nav.consignments': 'Consignment',
    'nav.agents': 'Approval',
    'nav.metals': 'Precious Metals',
    'nav.documents': 'Documents',
    'nav.tasks': 'Tasks',
    'nav.analytics': 'Analytics',
    'nav.settings': 'Settings',
    'nav.signout': 'Sign Out',
    'nav.sales': 'SALES',
    'nav.operations': 'OPERATIONS',
    'nav.insights': 'INSIGHTS',

    // Common
    'common.save': 'Save',
    'common.cancel': 'Cancel',
    'common.delete': 'Delete',
    'common.edit': 'Edit',
    'common.create': 'Create',
    'common.search': 'Search',
    'common.filter': 'Filter',
    'common.all': 'All',
    'common.back': 'Back',
    'common.yes': 'Yes',
    'common.no': 'No',
    'common.loading': 'Loading...',
    'common.nodata': 'No data yet.',

    // Dashboard
    'dashboard.greeting_morning': 'Good morning',
    'dashboard.greeting_afternoon': 'Good afternoon',
    'dashboard.greeting_evening': 'Good evening',
    'dashboard.revenue': 'REVENUE',
    'dashboard.profit': 'PROFIT',
    'dashboard.stock_value': 'STOCK VALUE',
    'dashboard.collection': 'COLLECTION',
    'dashboard.top_clients': 'TOP CLIENTS',
    'dashboard.featured': 'FEATURED FROM COLLECTION',

    // Products
    'product.new': 'New Item',
    'product.brand': 'Brand',
    'product.name': 'Name / Model',
    'product.sku': 'SKU / Reference',
    'product.condition': 'Condition',
    'product.purchase_price': 'Purchase Price',
    'product.sale_price': 'Sale Price',
    'product.margin': 'Margin',
    'product.tax_scheme': 'Tax Scheme',

    // Auth
    'auth.login': 'Sign In',
    'auth.email': 'EMAIL',
    'auth.password': 'PASSWORD',
    'auth.signing_in': 'Signing in...',
  },
  ar: {
    // Navigation
    'nav.dashboard': 'لوحة التحكم',
    'nav.clients': 'العملاء',
    'nav.collection': 'المجموعة',
    'nav.offers': 'العروض',
    'nav.invoices': 'الفواتير',
    'nav.orders': 'الطلبات',
    'nav.repairs': 'الإصلاحات',
    'nav.consignments': 'الشحنات',
    'nav.agents': 'الوكلاء',
    'nav.metals': 'المعادن الثمينة',
    'nav.documents': 'المستندات',
    'nav.tasks': 'المهام',
    'nav.analytics': 'التحليلات',
    'nav.settings': 'الإعدادات',
    'nav.signout': 'تسجيل الخروج',
    'nav.sales': 'المبيعات',
    'nav.operations': 'العمليات',
    'nav.insights': 'الرؤى',

    // Common
    'common.save': 'حفظ',
    'common.cancel': 'إلغاء',
    'common.delete': 'حذف',
    'common.edit': 'تعديل',
    'common.create': 'إنشاء',
    'common.search': 'بحث',
    'common.filter': 'تصفية',
    'common.all': 'الكل',
    'common.back': 'رجوع',
    'common.yes': 'نعم',
    'common.no': 'لا',
    'common.loading': 'جاري التحميل...',
    'common.nodata': 'لا توجد بيانات.',

    // Dashboard
    'dashboard.greeting_morning': 'صباح الخير',
    'dashboard.greeting_afternoon': 'مساء الخير',
    'dashboard.greeting_evening': 'مساء الخير',
    'dashboard.revenue': 'الإيرادات',
    'dashboard.profit': 'الربح',
    'dashboard.stock_value': 'قيمة المخزون',
    'dashboard.collection': 'المجموعة',
    'dashboard.top_clients': 'أفضل العملاء',
    'dashboard.featured': 'مميز من المجموعة',

    // Products
    'product.new': 'منتج جديد',
    'product.brand': 'العلامة التجارية',
    'product.name': 'الاسم / الطراز',
    'product.sku': 'الرقم المرجعي',
    'product.condition': 'الحالة',
    'product.purchase_price': 'سعر الشراء',
    'product.sale_price': 'سعر البيع',
    'product.margin': 'الهامش',
    'product.tax_scheme': 'نظام الضريبة',

    // Auth
    'auth.login': 'تسجيل الدخول',
    'auth.email': 'البريد الإلكتروني',
    'auth.password': 'كلمة المرور',
    'auth.signing_in': 'جاري تسجيل الدخول...',
  },
};

export function t(key: string): string {
  return translations[currentLang][key] || translations.en[key] || key;
}

// Initialize direction on load
if (currentLang === 'ar') {
  document.documentElement.dir = 'rtl';
  document.documentElement.lang = 'ar';
}
