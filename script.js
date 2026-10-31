import { products, categories, currency } from './catalog.js';

const money = new Intl.NumberFormat('tr-TR', { style: 'currency', currency });
const number = new Intl.NumberFormat('tr-TR');
const storageKey = 'grandsell-bag-v1';
const maximumQuantity = 99;
const pageSize = 24;
const $ = (selector) => document.querySelector(selector);
const productById = new Map(products.map((product) => [product.id, product]));
const productDialog = $('#product-dialog');
const cartDialog = $('#cart-dialog');
let activeCategory = 'all';
let currentPage = 1;
let selectedProduct;
let quantity = 1;
let toastTimeout;
let canSaveCart = true;
let descriptionSearchState = 'idle';
let descriptionSearchPromise;
const descriptionRequests = new Map();

function normalizeSearch(value) {
  return String(value ?? '').toLocaleLowerCase('tr-TR').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i');
}

const searchableProducts = products.map((product) => ({
  product,
  text: normalizeSearch([product.name, product.sku, product.barcode, product.categoryPath, product.subtitle, product.description, product.brand].join(' ')),
}));

async function fetchDescriptions(filename) {
  const response = await fetch(new URL(filename, import.meta.url));
  if (!response.ok) throw new Error('Description request failed');
  const descriptions = await response.json();
  if (!descriptions || typeof descriptions !== 'object' || Array.isArray(descriptions)) {
    throw new Error('Invalid descriptions');
  }
  return descriptions;
}

function loadDescription(product) {
  if (typeof product.description === 'string') return Promise.resolve(product.description);
  const filename = product.descriptionFile;
  if (!descriptionRequests.has(filename)) {
    descriptionRequests.set(filename, fetchDescriptions(filename).then((descriptions) => {
      for (const [id, description] of Object.entries(descriptions)) {
        const entry = productById.get(id);
        if (entry && typeof description === 'string') entry.description = description;
      }
    }).catch((error) => {
      descriptionRequests.delete(filename);
      throw error;
    }));
  }
  return descriptionRequests.get(filename).then(() => {
    if (typeof product.description !== 'string') throw new Error('Missing description');
    return product.description;
  });
}

function ensureDescriptionSearch() {
  if (descriptionSearchState === 'loaded' || descriptionSearchPromise) return;
  descriptionSearchState = 'loading';
  descriptionSearchPromise = fetchDescriptions('catalog-search.json').then((descriptions) => {
    if (products.some((product) => typeof descriptions[product.id] !== 'string')) {
      throw new Error('Incomplete description search');
    }
    for (const entry of searchableProducts) {
      entry.product.description = descriptions[entry.product.id];
      entry.text += ' ' + normalizeSearch(entry.product.description);
    }
    descriptionSearchState = 'loaded';
  }).catch(() => {
    descriptionSearchState = 'error';
    descriptionSearchPromise = undefined;
  }).finally(renderProducts);
}

function hasPrice(product) {
  return Number.isFinite(product.price) && product.price > 0;
}

function quantityLimit(product) {
  if (!product || !hasPrice(product)) return 0;
  return Math.max(0, Math.min(maximumQuantity, Math.floor(Number(product.stock) || 0)));
}

function priceLabel(product) {
  return hasPrice(product) ? money.format(product.price) : 'Price unavailable';
}

function stockLabel(product) {
  return product.stock > 0 ? `${number.format(product.stock)} in stock` : 'Out of stock';
}

// Stored values are untrusted; discard removed products and clamp to imported stock.
function restoreCart() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '[]');
    if (!Array.isArray(saved)) return [];
    const restored = [];
    for (const item of saved) {
      if (!item || typeof item !== 'object') continue;
      const product = productById.get(item.productId);
      const limit = quantityLimit(product);
      if (!limit || !Number.isInteger(item.quantity) || item.quantity < 1) continue;
      const existing = restored.find((entry) => entry.productId === product.id);
      if (existing) existing.quantity = Math.min(limit, existing.quantity + item.quantity);
      else restored.push({ productId: product.id, quantity: Math.min(limit, item.quantity) });
    }
    return restored;
  } catch {
    return [];
  }
}

let cart = restoreCart();

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

const imageFallback = `<svg class="product-image-fallback" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" role="img" aria-label="Product photo unavailable"><path d="m100 38 58 31v64l-58 31-58-31V69Z" fill="#e2e6da" stroke="#7b8978" stroke-width="3"/><path d="m42 69 58 31 58-31M100 100v64M72 53l58 32v24" fill="none" stroke="#7b8978" stroke-width="3"/><text x="100" y="189" text-anchor="middle" fill="#5d6659" font-family="Arial,sans-serif" font-size="10">Photo unavailable</text></svg>`;

function productImage(product, eager = false) {
  const url = product.images?.find((image) => typeof image === 'string' && /^https:\/\//i.test(image));
  if (!url) return imageFallback;
  return `<img data-product-image src="${escapeHTML(url)}" alt="${escapeHTML(product.name)}" loading="${eager ? 'eager' : 'lazy'}" fetchpriority="${eager ? 'high' : 'auto'}" decoding="async" width="400" height="400">`;
}

// Capturing also handles failures on images added later by pagination or dialogs.
document.addEventListener('error', (event) => {
  const image = event.target;
  if (image instanceof HTMLImageElement && image.hasAttribute('data-product-image')) {
    image.outerHTML = imageFallback;
  }
}, true);

function announce(message) {
  const dialogStatus = $('dialog[open] .dialog-status');
  if (dialogStatus) {
    dialogStatus.textContent = message;
    return;
  }
  clearTimeout(toastTimeout);
  $('#toast').textContent = message;
  $('#toast').classList.add('visible');
  toastTimeout = setTimeout(() => $('#toast').classList.remove('visible'), 3500);
}

function saveCart() {
  try {
    localStorage.setItem(storageKey, JSON.stringify(cart));
    canSaveCart = true;
  } catch {
    canSaveCart = false;
  }
  $('#storage-note').hidden = canSaveCart;
}

function renderProducts() {
  const query = normalizeSearch($('#product-search').value.trim());
  const matches = searchableProducts.filter(({ product, text }) =>
    (activeCategory === 'all' || product.category === activeCategory) && text.includes(query)
  );
  const pageCount = Math.max(1, Math.ceil(matches.length / pageSize));
  currentPage = Math.min(currentPage, pageCount);
  const start = (currentPage - 1) * pageSize;
  const visibleProducts = matches.slice(start, start + pageSize);
  $('#product-grid').innerHTML = visibleProducts.map(({ product }, index) => `
    <article class="product-card">
      <button class="product-link" data-product="${escapeHTML(product.id)}" aria-label="View ${escapeHTML(product.name)}">
        <div class="product-art">${productImage(product, index < 3)}${product.stock <= 0 ? '<span class="product-tag">Out of stock</span>' : ''}</div>
        <div class="product-info"><p class="product-category">${escapeHTML(categories[product.category])}</p><h3>${escapeHTML(product.name)}</h3><p class="product-subtitle">${escapeHTML(priceLabel(product))}</p><p class="product-code">SKU: ${escapeHTML(product.sku || product.id)}</p><span class="product-arrow" aria-hidden="true">↗</span></div>
      </button>
    </article>`).join('');
  const department = activeCategory !== 'all' ? ` in ${categories[activeCategory]}` : '';
  $('#results-count').textContent = matches.length
    ? `Showing ${number.format(start + 1)}–${number.format(start + visibleProducts.length)} of ${number.format(matches.length)} products${department}`
    : `0 products${department}`;
  $('#empty-state').hidden = matches.length !== 0;
  $('#product-pagination').hidden = pageCount <= 1;
  $('#product-page').textContent = `Page ${number.format(currentPage)} of ${number.format(pageCount)}`;
  $('#previous-products').disabled = currentPage === 1;
  $('#next-products').disabled = currentPage === pageCount;
  const searchingDescriptions = query && descriptionSearchState === 'loading';
  const descriptionSearchFailed = query && descriptionSearchState === 'error';
  $('#search-status').hidden = !searchingDescriptions && !descriptionSearchFailed;
  $('#search-status').textContent = searchingDescriptions ? 'Searching product descriptions…'
    : descriptionSearchFailed ? 'Description search is unavailable. You can still search names, categories, SKU and barcode.' : '';
}

function openDialog(dialog) {
  dialog.querySelector('.dialog-status').textContent = '';
  dialog.showModal();
  dialog.scrollTop = 0;
  document.body.classList.add('dialog-open');
}

function closeDialog(dialog) {
  dialog.close();
}

function availableQuantity(product) {
  return Math.max(0, quantityLimit(product) - (cart.find((item) => item.productId === product.id)?.quantity || 0));
}

function renderQuantity() {
  const available = availableQuantity(selectedProduct);
  quantity = available ? Math.max(1, Math.min(quantity, available)) : 0;
  $('#product-quantity').value = quantity;
  $('#decrease-quantity').disabled = quantity <= 1;
  $('#increase-quantity').disabled = quantity >= available;
  $('#add-to-cart').disabled = available === 0;
  $('#add-to-cart').textContent = !hasPrice(selectedProduct) ? 'Price unavailable'
    : selectedProduct.stock <= 0 ? 'Out of stock'
      : available === 0 ? 'Bag limit reached' : 'Add to bag +';
}

function showProduct(productId) {
  selectedProduct = productById.get(productId);
  if (!selectedProduct) return;
  quantity = 1;
  $('#dialog-title').textContent = selectedProduct.name;
  $('#dialog-category').textContent = selectedProduct.categoryPath || categories[selectedProduct.category];
  const product = selectedProduct;
  const descriptionPanel = $('#dialog-description');
  descriptionPanel.textContent = typeof product.description === 'string'
    ? product.description || 'No additional description is available.' : 'Loading description…';
  descriptionPanel.setAttribute('aria-busy', String(typeof product.description !== 'string'));
  loadDescription(product).then((description) => {
    if (selectedProduct !== product) return;
    descriptionPanel.textContent = description || 'No additional description is available.';
    descriptionPanel.setAttribute('aria-busy', 'false');
    descriptionPanel.scrollTop = 0;
  }).catch(() => {
    if (selectedProduct !== product) return;
    descriptionPanel.textContent = 'Description could not be loaded. Reopen this product to try again.';
    descriptionPanel.setAttribute('aria-busy', 'false');
  });
  $('#dialog-price').textContent = priceLabel(selectedProduct);
  $('#dialog-art').innerHTML = productImage(selectedProduct, true);
  $('#dialog-stock').textContent = stockLabel(selectedProduct);
  $('#dialog-identifiers').textContent = [
    `SKU: ${selectedProduct.sku || selectedProduct.id}`,
    selectedProduct.barcode ? `Barcode: ${selectedProduct.barcode}` : '',
    selectedProduct.brand ? `Brand: ${selectedProduct.brand}` : '',
  ].filter(Boolean).join(' · ');
  renderQuantity();
  openDialog(productDialog);
  productDialog.querySelectorAll('.dialog-copy, .dialog-description-panel, #dialog-description').forEach((panel) => {
    panel.scrollTop = 0;
  });
}

function renderCart() {
  const count = cart.reduce((total, item) => total + item.quantity, 0);
  $('#cart-count').textContent = number.format(count);
  $('#cart-heading-count').textContent = count ? ` (${number.format(count)})` : '';
  $('#open-cart').setAttribute('aria-label', `Open cart, ${count} ${count === 1 ? 'item' : 'items'}`);
  $('#cart-empty').hidden = count !== 0;
  $('#cart-summary').hidden = count === 0;
  $('#cart-items').innerHTML = cart.map((item, index) => {
    const product = productById.get(item.productId);
    return `<article class="cart-item">
      <div class="cart-item-art" aria-hidden="true">${productImage(product)}</div>
      <div class="cart-item-detail"><h3>${escapeHTML(product.name)}</h3><p>SKU: ${escapeHTML(product.sku || product.id)} · ${escapeHTML(priceLabel(product))} each</p><div class="cart-item-actions"><div class="quantity-control"><button data-action="decrease" data-index="${index}" aria-label="Decrease quantity of ${escapeHTML(product.name)}" ${item.quantity === 1 ? 'disabled' : ''}>−</button><span>${item.quantity}</span><button data-action="increase" data-index="${index}" aria-label="Increase quantity of ${escapeHTML(product.name)}" ${item.quantity >= quantityLimit(product) ? 'disabled' : ''}>+</button></div><button class="remove-item" data-action="remove" data-index="${index}" aria-label="Remove ${escapeHTML(product.name)}">Remove</button></div></div>
      <strong class="cart-item-total">${money.format(product.price * item.quantity)}</strong>
    </article>`;
  }).join('');
  $('#cart-subtotal').textContent = money.format(cart.reduce((total, item) => total + productById.get(item.productId).price * item.quantity, 0));
}

$('#category-filter').innerHTML = '<option value="all">All categories</option>' + Object.entries(categories)
  .map(([id, label]) => `<option value="${escapeHTML(id)}">${escapeHTML(label)}</option>`).join('');
$('#category-filter').addEventListener('change', (event) => {
  activeCategory = event.target.value;
  currentPage = 1;
  renderProducts();
});
$('#product-search').addEventListener('input', () => {
  currentPage = 1;
  if ($('#product-search').value.trim()) ensureDescriptionSearch();
  renderProducts();
});
$('#reset-filters').addEventListener('click', () => {
  $('#product-search').value = '';
  $('#category-filter').value = 'all';
  activeCategory = 'all';
  currentPage = 1;
  renderProducts();
  $('#product-search').focus();
});
for (const [id, direction] of [['#previous-products', -1], ['#next-products', 1]]) {
  $(id).addEventListener('click', () => {
    currentPage += direction;
    renderProducts();
    $('#results-count').scrollIntoView({ behavior: 'instant', block: 'start' });
    $('#results-count').focus({ preventScroll: true });
  });
}
$('#product-grid').addEventListener('click', (event) => {
  const button = event.target.closest('[data-product]');
  if (button) showProduct(button.dataset.product);
});
$('#decrease-quantity').addEventListener('click', () => { quantity -= 1; renderQuantity(); });
$('#increase-quantity').addEventListener('click', () => { quantity += 1; renderQuantity(); });
$('#add-to-cart').addEventListener('click', () => {
  const addedQuantity = Math.min(quantity, availableQuantity(selectedProduct));
  if (addedQuantity <= 0) { renderQuantity(); return; }
  const existing = cart.find((item) => item.productId === selectedProduct.id);
  if (existing) existing.quantity += addedQuantity;
  else cart.push({ productId: selectedProduct.id, quantity: addedQuantity });
  saveCart();
  renderCart();
  closeDialog(productDialog);
  announce(`${addedQuantity} ${selectedProduct.name} added to your bag.${canSaveCart ? '' : ' Your browser could not save it for next time.'}`);
});
$('#cart-items').addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const index = Number(button.dataset.index);
  const item = cart[index];
  if (!item) return;
  const action = button.dataset.action;
  const product = productById.get(item.productId);
  if (action === 'remove') cart.splice(index, 1);
  else item.quantity = Math.max(1, Math.min(quantityLimit(product), item.quantity + (action === 'increase' ? 1 : -1)));
  saveCart();
  renderCart();
  const nextButton = $(`#cart-items [data-index="${Math.min(index, cart.length - 1)}"][data-action="${action}"]:not(:disabled)`);
  (nextButton || (cart.length ? $('#close-cart') : $('#start-browsing'))).focus();
  announce(action === 'remove' ? `${product.name} removed from your bag.` : `${product.name} quantity updated to ${item.quantity}.`);
});
$('#open-cart').addEventListener('click', () => { renderCart(); openDialog(cartDialog); });
$('#close-dialog').addEventListener('click', () => closeDialog(productDialog));
$('#close-cart').addEventListener('click', () => closeDialog(cartDialog));
for (const id of ['#start-browsing', '#continue-shopping']) {
  $(id).addEventListener('click', () => {
    closeDialog(cartDialog);
    $('#shop').scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    $('#category-filter').focus({ preventScroll: true });
  });
}
for (const dialog of [productDialog, cartDialog]) {
  dialog.addEventListener('close', () => document.body.classList.remove('dialog-open'));
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeDialog(dialog);
  });
}

$('#year').textContent = new Date().getFullYear();
renderProducts();
renderCart();

