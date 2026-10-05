import {
  fetchAllCategories,
  insertCategoryRow,
  updateCategoryRow,
  deleteCategoryRow,
} from '../services/supabase.js';
import { buildCategoryTranslationFields, langMapFromRow } from '../services/poi-translate.js';
import { localizedText } from '../config/i18n.js';

/** In-memory categories for the active project (navme_categories). */
export const categoriesData = [];

export function normalizeCategoryRow(row) {
  return {
    id: row.id,
    name: String(row.name ?? 'Category').trim() || 'Category',
    icon_key: String(row.icon_key ?? 'map-pin').trim() || 'map-pin',
    sort_order: Number(row.sort_order ?? 0),
    name_langs: langMapFromRow(row, 'name', 'category_names'),
  };
}

/** Category name in the dashboard's active language (falls back to English). */
export function categoryDisplayName(category) {
  return localizedText(category?.name_langs, category?.name) || 'Category';
}

export function sortCategoriesInPlace() {
  categoriesData.sort((a, b) => {
    const order = a.sort_order - b.sort_order;
    if (order !== 0) return order;
    return categoryDisplayName(a).localeCompare(categoryDisplayName(b));
  });
}

export async function hydrateCategoriesFromSupabase() {
  categoriesData.length = 0;
  const rows = await fetchAllCategories();
  rows.forEach((row) => categoriesData.push(normalizeCategoryRow(row)));
  sortCategoriesInPlace();
}

/** @param {string | null | undefined} categoryId */
export function getCategoryById(categoryId) {
  const id = String(categoryId ?? '').trim();
  if (!id) return null;
  return categoriesData.find((c) => String(c.id) === id) ?? null;
}

/** @param {string | null | undefined} categoryId */
export function getCategoryLabel(categoryId) {
  const category = getCategoryById(categoryId);
  return category ? categoryDisplayName(category) : 'Uncategorized';
}

export async function addCategoryWithDb({ name, icon_key, sort_order = 0 }) {
  const trimmedName = String(name ?? '').trim();
  const translationFields = await buildCategoryTranslationFields(trimmedName);
  const inserted = await insertCategoryRow({
    name: trimmedName,
    icon_key: String(icon_key ?? 'map-pin').trim() || 'map-pin',
    sort_order: Number(sort_order) || 0,
    ...translationFields,
  });
  const row = Array.isArray(inserted) ? inserted[0] : inserted;
  const normalized = normalizeCategoryRow(row);
  categoriesData.push(normalized);
  sortCategoriesInPlace();
  return categoriesData.findIndex((c) => c.id === normalized.id);
}

export async function saveCategoryToDb(index, { translate = true } = {}) {
  const cat = categoriesData[index];
  if (!cat?.id) return;

  const payload = {
    name: cat.name,
    icon_key: cat.icon_key,
    sort_order: cat.sort_order,
  };

  if (translate) {
    Object.assign(payload, await buildCategoryTranslationFields(cat.name));
  }

  await updateCategoryRow(cat.id, payload);
}

export async function removeCategoryFromDb(index) {
  const cat = categoriesData[index];
  if (cat?.id) {
    await deleteCategoryRow(cat.id);
  }
}

export function deleteCategoryLocal(index) {
  if (index < 0 || index >= categoriesData.length) return;
  categoriesData.splice(index, 1);
}

export function getCategoriesCount() {
  return categoriesData.length;
}
