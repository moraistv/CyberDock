<template>
    <div class="main-container">
        <!-- Painel de Filtros Melhorado -->
        <div class="filters-panel-v2">
             <!-- Linha principal com filtros rápidos e ações primárias -->
            <div class="filters-main-row">
                <div class="filters-left-group">
                    <!-- Busca -->
                    <div class="search-wrapper">
                        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24" fill="none"
                            stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                            class="search-icon">
                            <circle cx="11" cy="11" r="8"></circle>
                            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                        </svg>
                        <input type="text" v-model="searchQuery" placeholder="Buscar por produto, SKU, usuário..."
                            class="search-input">
                    </div>

                    <!-- Filtro rápido: Status da Venda -->
                    <div class="filter-container" ref="saleStatusFilterContainerRef">
                        <button @click="toggleSaleStatusDropdown" class="btn btn-outline">
                            <span class="truncate pr-2">{{ selectedSaleStatusFilter ? `Venda: ${getSaleStatusLabel(selectedSaleStatusFilter)}` : 'Status da Venda' }}</span>
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4 shrink-0 opacity-50">
                                <path d="m6 9 6 6 6-6"></path>
                            </svg>
                        </button>
                        <div v-if="isSaleStatusDropdownOpen" ref="saleStatusFilterDropdownRef" class="filter-popover">
                            <ul class="filter-popover-list">
                                <li @click="applySaleStatusFilter(null)">
                                    <span :class="{'font-bold': !selectedSaleStatusFilter}">Todos</span>
                                </li>
                                <li v-for="status in saleStatusOptions" :key="status.value" @click="applySaleStatusFilter(status.value)">
                                     <span :class="{'font-bold': selectedSaleStatusFilter === status.value}">{{ status.label }}</span>
                                </li>
                            </ul>
                        </div>
                    </div>

                    <!-- Filtro rápido: Status de Expedição -->
                    <div class="filter-container" ref="statusFilterContainerRef">
                        <button @click="toggleStatusDropdown" class="btn btn-outline">
                            <span class="truncate pr-2">{{ selectedStatusFilter ? `Expedição: ${getStatusLabel(selectedStatusFilter)}` : 'Status de Expedição' }}</span>
                             <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4 shrink-0 opacity-50">
                                <path d="m6 9 6 6 6-6"></path>
                            </svg>
                        </button>
                        <div v-if="isStatusDropdownOpen" ref="statusFilterDropdownRef" class="filter-popover">
                            <ul class="filter-popover-list">
                                <li @click="applyStatusFilter(null)">
                                    <span :class="{'font-bold': !selectedStatusFilter}">Todos</span>
                                </li>
                                <li v-for="status in systemStatuses" :key="status.value" @click="applyStatusFilter(status.value)">
                                    <span :class="{'font-bold': selectedStatusFilter === status.value}">{{ status.label }}</span>
                                </li>
                            </ul>
                        </div>
                    </div>

                </div>
                <div class="filters-right-group">
                    <!-- Botão para Filtros Avançados -->
                    <button @click="toggleAdvancedFilters" class="btn btn-ghost">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="mr-2 h-4 w-4">
                            <path d="M3 6h18M7 12h10M10 18h4"></path>
                        </svg>
                        Filtros Avançados
                    </button>
                </div>
            </div>

            <!-- Filtros Avançados -->
            <div v-if="showAdvancedFilters" class="advanced-filters-content">
                <div class="advanced-filters-grid">
                    <!-- Filtro de Data da Venda -->
                    <div class="filter-group date-range-group">
                        <label for="sale-date-start">Data da Venda</label>
                        <div class="date-inputs">
                            <input id="sale-date-start" type="date" v-model="filters.saleDateStart">
                            <span>até</span>
                            <input id="sale-date-end" type="date" v-model="filters.saleDateEnd">
                        </div>
                    </div>

                    <!-- Filtro de Limite de Envio -->
                    <div class="filter-group date-range-group">
                        <label for="shipping-limit-start">Limite de Envio</label>
                        <div class="date-inputs">
                            <input id="shipping-limit-start" type="date" v-model="filters.shippingLimitStart">
                            <span>até</span>
                            <input id="shipping-limit-end" type="date" v-model="filters.shippingLimitEnd">
                        </div>
                    </div>
                </div>
                 <div class="advanced-filters-actions">
                    <button @click="clearFilters" class="btn btn-secondary">Limpar Filtros</button>
                </div>
            </div>

            <!-- Ações da Tabela -->
            <div class="table-actions-bar">
                <div class="table-actions-left">
                    <button @click="processAllSales" class="btn btn-primary" :disabled="isProcessing">
                        <span v-if="isProcessing">Processando...</span>
                        <span v-else>Processar Vendas Filtradas</span>
                    </button>
                </div>
            </div>
        </div>


        <!-- Container da Tabela de Vendas -->
        <div class="sales-table-container">
            <div v-if="isLoading" class="loading-state">
                <p>Carregando todas as vendas...</p>
            </div>
            <div v-else-if="error" class="error-state">
                <p>{{ error }}</p>
            </div>
            <div v-else-if="sales.length === 0" class="empty-state">
                <h3 class="empty-state-title">Nenhuma venda encontrada no sistema</h3>
                <p class="empty-state-text">Parece que ainda não há vendas de nenhum usuário.</p>
                <button @click="fetchSales" class="btn btn-primary empty-state-cta">Recarregar</button>
            </div>
            <div v-else-if="filteredUserSales.length === 0" class="empty-state">
                <p>Nenhuma venda encontrada para os filtros selecionados.</p>
                <button @click="clearFilters" class="btn btn-secondary">Limpar Filtros</button>
            </div>
            <div v-else>
                <div class="table-wrapper">
                    <table class="sales-table">
                        <thead>
                            <tr>
                                <th>Usuário</th>
                                <th>Canal</th>
                                <th>Conta</th>
                                <th>Cliente</th>
                                <th>ID da Venda</th>
                                <th>Data da Venda</th>
                                <th>Produto</th>
                                <th>SKU</th>
                                <th>Qtd.</th>
                                <th>Modo Envio</th>
                                <th>Processada</th>
                                <th>Data Limite</th>
                                <th>Status</th>
                                <th>Etiquetas</th>
                            </tr>
                        </thead>
                        <tbody ref="salesTableBodyRef">
                            <tr v-for="sale in paginatedUserSales" :key="`${sale.id}-${sale.sku}`" :class="{ 'cancelled-sale': sale.raw_api_data?.status === 'cancelled' }">
                                <td data-label="Usuário">{{ sale.user_nickname || 'N/A' }}</td>
                                <td data-label="Canal"><span class="channel-badge ml">{{ sale.channel }}</span></td>
                                <td data-label="Conta">{{ sale.account_nickname }}</td>
                                <td data-label="Cliente" class="customer-name-cell"
                                    @mouseenter="showTooltip($event, getCustomerName(sale))" @mouseleave="hideTooltip">
                                    {{ getCustomerName(sale) }}
                                </td>
                                <td data-label="ID da Venda" class="sale-id-cell" 
                                    @click="copySaleId(sale.id)" 
                                    :title="'Clique para copiar: ' + (sale.id || 'N/A')"
                                    style="cursor: pointer; color: #3b82f6; text-decoration: underline;">
                                    {{ sale.id || 'N/A' }}
                                </td>
                                <td data-label="Data da Venda">{{ formatDateTime(sale.sale_date) }}</td>
                                <td data-label="Produto" class="product-title"
                                    @mouseenter="showTooltip($event, sale.product_title)" @mouseleave="hideTooltip">
                                    {{ sale.product_title }}
                                </td>
                                <td data-label="SKU" class="sku-cell"
                                    @mouseenter="showTooltip($event, sale.sku || 'N/A')" @mouseleave="hideTooltip">
                                    {{ sale.sku || 'N/A' }}
                                </td>
                                <td data-label="Qtd.">{{ sale.quantity }}</td>
                                <td data-label="Modo Envio">{{ sale.shipping_mode || 'N/A' }}</td>
                                <td data-label="Processada">
                                    <span v-if="sale.processed_at" class="tag processed"
                                        :title="`Processado em: ${formatDateTime(sale.processed_at)}`">Sim</span>
                                    <span v-else class="tag unprocessed">Não</span>
                                </td>
                                <td data-label="Data Limite">{{ formatDateTime(sale.raw_api_data?.sla_data?.expected_date || sale.shipping_limit_date) }}</td>
                                <td data-label="Status">
                                     <div class="status-select-trigger compact"
                                        @mouseenter="showTooltip($event, getStatusLabel(sale.shipping_status))"
                                        @mouseleave="hideTooltip">
                                        <span :class="['status-badge', getStatusColorClass(sale.shipping_status)]"></span>
                                        <span>{{ getStatusLabel(sale.shipping_status) }}</span>
                                    </div>
                                </td>
                                <td data-label="Etiquetas">
                                    <div class="label-actions">
                                        <button 
                                            v-if="getLabelInfo(sale).canPrint"
                                            @click="openLabelWithToken(sale, getLabelInfo(sale).pdfUrl)"
                                            class="btn-label pdf"
                                            title="Imprimir Etiqueta PDF"
                                        >
                                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                                <polyline points="6,9 6,2 18,2 18,9"></polyline>
                                                <path d="M6,18H4a2,2,0,0,1-2-2V11a2,2,0,0,1,2-2H20a2,2,0,0,1,2,2v5a2,2,0,0,1-2,2H18"></path>
                                                <polyline points="6,14 18,14 18,18 6,18"></polyline>
                                            </svg>
                                            PDF
                                        </button>
                                        <button 
                                            v-if="getLabelInfo(sale).canPrint"
                                            @click="openLabelWithToken(sale, getLabelInfo(sale).zplUrl)"
                                            class="btn-label zpl"
                                            title="Imprimir Etiqueta ZPL"
                                        >
                                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                                <polyline points="6,9 6,2 18,2 18,9"></polyline>
                                                <path d="M6,18H4a2,2,0,0,1-2-2V11a2,2,0,0,1,2-2H20a2,2,0,0,1,2,2v5a2,2,0,0,1-2,2H18"></path>
                                                <polyline points="6,14 18,14 18,18 6,18"></polyline>
                                            </svg>
                                            ZPL
                                        </button>
                                        <span v-else class="label-unavailable">—</span>
                                        
                                        <!-- Debug info (temporário) -->
                                        <div class="debug-info" style="font-size: 10px; color: #666; margin-top: 2px;">
                                            Status: {{ sale?.raw_api_data?.status || 'N/A' }}<br>
                                            Shipment: {{ sale?.raw_api_data?.shipping?.id || 'N/A' }}<br>
                                            Seller: {{ sale?.seller_id || 'N/A' }}
                                        </div>
                                    </div>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
                <div class="pagination-controls" v-if="salesTotalPages > 1">
                    <button @click="prevSalesPage" :disabled="salesCurrentPage === 1">Anterior</button>
                    <span>Página {{ salesCurrentPage }} de {{ salesTotalPages }}</span>
                    <button @click="nextSalesPage" :disabled="salesCurrentPage === salesTotalPages">Próximo</button>
                </div>
            </div>
        </div>

        <div ref="tooltipRef" class="custom-tooltip">
            <span class="tooltip-content"></span>
            <div class="tooltip-arrow"></div>
        </div>

        <UniversalModal :is-open="isSummaryModalOpen" :title="summaryModalTitle" @close="isSummaryModalOpen = false">
            <div class="summary-modal-content" v-html="summaryModalContent"></div>
            <div class="modal-actions">
                <button @click="isSummaryModalOpen = false" class="btn btn-primary">Fechar</button>
            </div>
        </UniversalModal>

    </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, computed, watch, nextTick, reactive } from 'vue';
import gsap from 'gsap';
import { useSalesForUser } from '@/composables/useSalesForUser';
import { useUserStorage } from '@/composables/useUserStorage';
import { useSystemStatus } from '@/composables/useSystemStatus';
import { useLabels } from '@/composables/useLabels';
import UniversalModal from './UniversalModal.vue';

// ===== UTILITY FUNCTIONS FOR CUSTOMER DATA =====

/**
 * Extrai o nome do cliente dos dados da API do Mercado Livre
 * @param {Object} sale - Objeto da venda contendo raw_api_data
 * @returns {string} Nome do cliente ou 'N/A' se não disponível
 */
function getCustomerName(sale) {
    try {
        const buyer = sale?.raw_api_data?.buyer;
        if (!buyer) return 'N/A';
        
        // Prioridade: nome completo > nickname > ID do comprador
        if (buyer.first_name && buyer.last_name) {
            return `${buyer.first_name} ${buyer.last_name}`.trim();
        }
        if (buyer.nickname) {
            return buyer.nickname.trim();
        }
        if (buyer.id) {
            return `Cliente #${buyer.id}`;
        }
        return 'N/A';
    } catch (error) {
        console.warn('Erro ao extrair nome do cliente:', error);
        return 'N/A';
    }
}

/**
 * Copia o ID da venda para a área de transferência
 * @param {number|string} saleId - ID da venda a ser copiado
 */
async function copySaleId(saleId) {
    try {
        if (!saleId) {
            throw new Error('ID da venda não disponível');
        }
        
        const idString = saleId.toString();
        
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(idString);
            showToast('ID copiado para a área de transferência', 'success');
        } else {
            // Fallback para navegadores antigos
            const textArea = document.createElement('textarea');
            textArea.value = idString;
            textArea.style.position = 'fixed';
            textArea.style.left = '-999999px';
            textArea.style.top = '-999999px';
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();
            
            const successful = document.execCommand('copy');
            document.body.removeChild(textArea);
            
            if (successful) {
                showToast('ID copiado para a área de transferência', 'success');
            } else {
                throw new Error('Falha ao copiar usando fallback');
            }
        }
    } catch (error) {
        console.error('Erro ao copiar ID:', error);
        showToast('Erro ao copiar ID da venda', 'error');
    }
}

/**
 * Exibe uma notificação toast simples
 * @param {string} message - Mensagem a ser exibida
 * @param {string} type - Tipo da notificação ('success', 'error', 'info')
 */
function showToast(message, type = 'info') {
    // Implementação simples usando alert por enquanto
    // TODO: Integrar com sistema de toast existente
    if (type === 'error') {
        console.error(message);
    } else {
        console.log(message);
    }
    
    // Criar um toast visual simples
    const toast = document.createElement('div');
    toast.textContent = message;
    toast.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: ${type === 'error' ? '#ef4444' : '#10b981'};
        color: white;
        padding: 12px 16px;
        border-radius: 6px;
        z-index: 9999;
        font-size: 14px;
        box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        transition: opacity 0.3s ease;
    `;
    
    document.body.appendChild(toast);
    
    // Remover após 3 segundos
    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => {
            if (toast.parentNode) {
                document.body.removeChild(toast);
            }
        }, 300);
    }, 3000);
}

// ===== END UTILITY FUNCTIONS =====

const { sales, isLoading, error, fetchSales, processSales: processSalesApi } = useSalesForUser(ref(null));
const { skus, loadStorageData } = useUserStorage(ref(null));
const { systemStatuses } = useSystemStatus();
const { generateLabelLinks, openLabel } = useLabels();


const salesTableBodyRef = ref(null);
const tooltipRef = ref(null);
let hideTooltipTimeout = null;
const salesCurrentPage = ref(1);
const salesItemsPerPage = ref(10);
const isProcessing = ref(false);
const isSummaryModalOpen = ref(false);
const summaryModalTitle = ref('');
const summaryModalContent = ref('');

const searchQuery = ref('');
const showAdvancedFilters = ref(false);


const selectedSaleStatusFilter = ref(null);
const isSaleStatusDropdownOpen = ref(false);
const saleStatusFilterContainerRef = ref(null);
const saleStatusFilterDropdownRef = ref(null);

const selectedStatusFilter = ref(null);
const isStatusDropdownOpen = ref(false);
const statusFilterContainerRef = ref(null);
const statusFilterDropdownRef = ref(null);

const filters = reactive({
    saleDateStart: '',
    saleDateEnd: '',
    shippingLimitStart: '',
    shippingLimitEnd: '',
    saleStatus: null,
    shippingStatus: null,
});

const normalizeSku = (sku) => (sku || '').trim().toUpperCase();

function parseFlexibleDate(value, { endOfDay = false } = {}) {
    if (!value) return null;
    let d = new Date(value.replace(/-/g, '/'));
    if (!d || isNaN(d)) return null;
    if (endOfDay) d.setHours(23, 59, 59, 999);
    else d.setHours(0, 0, 0, 0);
    return d;
}

const stockSkuSet = computed(() => {
    if (!Array.isArray(skus.value)) return new Set();
    return new Set(skus.value.map(s => normalizeSku(s.sku)));
});

const filteredUserSales = computed(() => {
    let tempSales = sales.value;

    if (selectedStatusFilter.value) {
        tempSales = tempSales.filter(s => s.shipping_status === selectedStatusFilter.value);
    }

    if (selectedSaleStatusFilter.value) {
        tempSales = tempSales.filter(s => (s.raw_api_data?.status || s.sale_status) === selectedSaleStatusFilter.value);
    }

    if (searchQuery.value) {
        const query = searchQuery.value.toLowerCase();
        tempSales = tempSales.filter(s =>
            (s.product_title?.toLowerCase().includes(query)) ||
            (s.sku?.toLowerCase().includes(query)) ||
            (s.account_nickname?.toLowerCase().includes(query)) ||
            (s.user_nickname?.toLowerCase().includes(query))
        );
    }

    if (filters.saleDateStart) {
        const start = parseFlexibleDate(filters.saleDateStart);
        if (start) tempSales = tempSales.filter(s => new Date(s.sale_date) >= start);
    }
    if (filters.saleDateEnd) {
        const end = parseFlexibleDate(filters.saleDateEnd, { endOfDay: true });
        if (end) tempSales = tempSales.filter(s => new Date(s.sale_date) <= end);
    }

    if (filters.shippingLimitStart) {
        const start = parseFlexibleDate(filters.shippingLimitStart);
        if (start) tempSales = tempSales.filter(s => {
            const limitDate = new Date(s.raw_api_data?.sla_data?.expected_date || s.shipping_limit_date);
            return limitDate >= start;
        });
    }
     if (filters.shippingLimitEnd) {
        const end = parseFlexibleDate(filters.shippingLimitEnd, { endOfDay: true });
        if (end) tempSales = tempSales.filter(s => {
            const limitDate = new Date(s.raw_api_data?.sla_data?.expected_date || s.shipping_limit_date);
            return limitDate <= end;
        });
    }

    return tempSales;
});

const salesTotalPages = computed(() => Math.ceil(filteredUserSales.value.length / salesItemsPerPage.value) || 1);
const paginatedUserSales = computed(() => {
    const startIndex = (salesCurrentPage.value - 1) * salesItemsPerPage.value;
    const paginated = filteredUserSales.value.slice(startIndex, startIndex + salesItemsPerPage.value);
    
    if (paginated.length > 0) {
        console.log('🔍 Debug vendas carregadas:', {
            totalSales: sales.value?.length || 0,
            filteredSales: filteredUserSales.value?.length || 0,
            paginatedSales: paginated.length,
            firstSale: paginated[0] ? {
                id: paginated[0].id,
                sku: paginated[0].sku,
                raw_api_data: paginated[0].raw_api_data,
                seller_id: paginated[0].seller_id
            } : null
        });
    }
    
    nextTick(() => {
        if (salesTableBodyRef.value?.children.length) {
            gsap.from(salesTableBodyRef.value.children, {
                opacity: 0, y: 20, duration: 0.5, stagger: 0.08, ease: 'power3.out'
            });
        }
    });
    return paginated;
});

watch([searchQuery, selectedSaleStatusFilter, selectedStatusFilter, filters], () => { salesCurrentPage.value = 1; }, { deep: true });

watch(selectedStatusFilter, (v) => { filters.shippingStatus = v ?? null; });
watch(() => filters.shippingStatus, (v) => { selectedStatusFilter.value = v ?? null; });

function formatDateTime(dateString) {
    if (!dateString) return 'N/A';
    const date = new Date(dateString);
    if (isNaN(date)) return 'Data inválida';
    return date.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const getStatusLabel = (s) => (systemStatuses.value.find(cs => cs.value === s)?.label || s || 'Pendente').replace(/_/g, ' ');

const saleStatusOptions = computed(() => {
    const set = new Set();
    (sales.value || []).forEach(s => {
        const v = s?.raw_api_data?.status || s?.sale_status || null;
        if (v) set.add(String(v));
    });
    return Array.from(set)
        .map(value => ({ value, label: getSaleStatusLabel(value) }))
        .sort((a, b) => a.label.localeCompare(b.label));
});

function getSaleStatusLabel(statusValue) {
    if (!statusValue) return 'Pendente';
    const map = {
        paid: 'Pago', ready_to_ship: 'Pronto para Envio', shipped: 'Enviado',
        delivered: 'Entregue', cancelled: 'Cancelado', canceled: 'Cancelado',
    };
    const key = String(statusValue).toLowerCase();
    return map[key] || (key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' '));
}

function getStatusColorClass(statusValue) {
    const valueLower = (statusValue || '').toLowerCase();
    if (valueLower === 'pendente') return 'status-badge-gray';
    if (valueLower.includes('imprimir')) return 'status-badge-indigo';
    if (valueLower.includes('preparar')) return 'status-badge-yellow';
    if (valueLower.includes('despachado')) return 'status-badge-red';
    if (valueLower.includes('embalado')) return 'status-badge-cyan';
    if (valueLower.includes('aguardando')) return 'status-badge-purple';
    if (valueLower.includes('enviado')) return 'status-badge-green';
    if (valueLower.includes('coleta')) return 'status-badge-orange';
    return 'status-badge-default';
}

function toggleAdvancedFilters() { showAdvancedFilters.value = !showAdvancedFilters.value; }
function toggleSaleStatusDropdown() { isSaleStatusDropdownOpen.value = !isSaleStatusDropdownOpen.value; }
function applySaleStatusFilter(statusValue) { selectedSaleStatusFilter.value = statusValue; isSaleStatusDropdownOpen.value = false; }
function toggleStatusDropdown() { isStatusDropdownOpen.value = !isStatusDropdownOpen.value; }
function applyStatusFilter(statusValue) { 
    selectedStatusFilter.value = statusValue; 
    filters.shippingStatus = statusValue ?? null; 
    isStatusDropdownOpen.value = false; 
}

function clearFilters() {
    filters.saleDateStart = '';
    filters.saleDateEnd = '';
    filters.shippingLimitStart = '';
    filters.shippingLimitEnd = '';
    filters.saleStatus = null;
    filters.shippingStatus = null;
    searchQuery.value = '';
    selectedStatusFilter.value = null;
    selectedSaleStatusFilter.value = null;
    salesCurrentPage.value = 1;
}

async function processAllSales() {
    isProcessing.value = true;
    try {
        await loadStorageData();
        const salesToProcess = filteredUserSales.value.filter(sale => {
            const saleSku = normalizeSku(sale.sku);
            const isSkuInStock = saleSku && stockSkuSet.value.has(saleSku);
            return !sale.processed_at && isSkuInStock;
        });

        if (salesToProcess.length === 0) {
            summaryModalTitle.value = 'Nenhuma Venda para Processar';
            summaryModalContent.value = '<p>Não foi encontrada nenhuma venda pendente com SKU correspondente no estoque para os filtros atuais.</p>';
            isSummaryModalOpen.value = true;
            return;
        }

        const results = await processSalesApi(salesToProcess);
        summaryModalTitle.value = 'Resumo do Processamento';
        let contentHtml = `<p>O processamento de ${salesToProcess.length} vendas foi concluído.</p>`;
        if (results.success?.length > 0) {
            contentHtml += `<div class="summary-section success"><h4>✅ ${results.success.length} Vendas Processadas</h4><ul>`;
            results.success.forEach(s => { contentHtml += `<li>Venda #${s.saleId} (SKU: ${s.sku})</li>`; });
            contentHtml += `</ul></div>`;
        }
        if (results.failed?.length > 0) {
            contentHtml += `<div class="summary-section failed"><h4>❌ ${results.failed.length} Falharam</h4><ul>`;
            results.failed.forEach(f => { contentHtml += `<li>Venda #${f.saleId} (SKU: ${f.sku}): <strong>${f.reason}</strong></li>`; });
            contentHtml += `</ul></div>`;
        }
        summaryModalContent.value = contentHtml;
        isSummaryModalOpen.value = true;

    } catch (err) {
        summaryModalTitle.value = 'Erro no Processamento';
        summaryModalContent.value = `<p>Ocorreu um erro inesperado:</p><p class="error-text">${err.message}</p>`;
        isSummaryModalOpen.value = true;
    } finally {
        await fetchSales();
        isProcessing.value = false;
    }
}

function handleClickOutside(event) {
    const target = event.target;
    if (saleStatusFilterContainerRef.value && !saleStatusFilterContainerRef.value.contains(target)) { isSaleStatusDropdownOpen.value = false; }
    if (statusFilterContainerRef.value && !statusFilterContainerRef.value.contains(target)) { isStatusDropdownOpen.value = false; }
}

function showTooltip(event, text) {
    const el = event.target;
    if (!el || !text || el.scrollWidth <= el.clientWidth) return;
    clearTimeout(hideTooltipTimeout);
    const tooltip = tooltipRef.value;
    if (!tooltip) return;
    tooltip.querySelector('.tooltip-content').textContent = text;
    const rect = el.getBoundingClientRect();
    tooltip.style.left = `${rect.left + rect.width / 2}px`;
    tooltip.style.top = `${rect.bottom + 8}px`;
    tooltip.style.transform = 'translateX(-50%)';
    gsap.to(tooltip, { autoAlpha: 1, y: 0, duration: 0.3, ease: 'power2.out' });
}

function hideTooltip() {
    hideTooltipTimeout = setTimeout(() => {
        if (tooltipRef.value) {
            gsap.to(tooltipRef.value, { autoAlpha: 0, y: -10, duration: 0.2, ease: 'power2.in' });
        }
    }, 100);
}

function nextSalesPage() { if (salesCurrentPage.value < salesTotalPages.value) salesCurrentPage.value++; }
function prevSalesPage() { if (salesCurrentPage.value > 1) salesCurrentPage.value--; }

function getLabelInfo(sale) {
    const result = generateLabelLinks(sale);
    console.log('🔍 Debug etiqueta para venda:', {
        saleId: sale.id,
        sku: sale.sku,
        status: sale?.raw_api_data?.status,
        shipmentId: sale?.raw_api_data?.shipping?.id,
        sellerId: sale?.seller_id,
        canPrint: result.canPrint,
        result: result
    });
    return result;
}

async function openLabelWithToken(sale, baseUrl) {
    if (!baseUrl) return;
    
    console.log('🔗 Abrindo etiqueta:', {
        saleId: sale.id,
        sellerId: sale.seller_id,
        baseUrl: baseUrl
    });
    
    try {
        const response = await fetch(`/api/ml/access-token/${sale.seller_id}`, {
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('token')}`
            }
        });
        
        if (response.ok) {
            const data = await response.json();
            const urlWithToken = `${baseUrl}&access_token=${data.access_token}`;
            console.log('✅ URL com token:', urlWithToken);
            openLabel(urlWithToken);
        } else {
            console.error('❌ Erro ao obter token de acesso:', response.status);
            console.log('🔄 Tentando abrir sem token...');
            openLabel(baseUrl);
        }
    } catch (error) {
        console.error('❌ Erro ao obter token:', error);
        console.log('🔄 Tentando abrir sem token...');
        openLabel(baseUrl);
    }
}

onMounted(() => { document.addEventListener('click', handleClickOutside); });
onUnmounted(() => { document.removeEventListener('click', handleClickOutside); });

</script>

<style scoped>
/* ============================================= */
/* NOVO PAINEL DE FILTROS (V2)          */
/* ============================================= */
.filters-panel-v2 {
    background-color: #f8fafc;
    border: 1px solid #e2e8f0;
    border-radius: 0.75rem;
    padding: 1rem;
    margin-bottom: 1.5rem;
    box-shadow: 0 1px 2px 0 rgba(0,0,0,0.05);
    display: flex;
    flex-direction: column;
    gap: 1rem;
}

.filters-main-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
    flex-wrap: wrap;
}

.filters-left-group, .filters-right-group {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
}

.search-wrapper {
    position: relative;
    min-width: 250px;
    flex-grow: 1;
}

.search-icon {
    position: absolute;
    left: 0.75rem;
    top: 50%;
    transform: translateY(-50%);
    width: 1rem;
    height: 1rem;
    color: #9ca3af;
}

.search-input {
    background-color: #fff;
    border: 1px solid #d1d5db;
    border-radius: 0.5rem;
    padding: 0.5rem 0.75rem 0.5rem 2.25rem;
    font-size: 0.875rem;
    width: 100%;
    transition: box-shadow 0.2s, border-color 0.2s;
}
.search-input:focus {
    outline: none;
    border-color: #4f46e5;
    box-shadow: 0 0 0 2px rgba(79, 70, 229, 0.2);
}

.filter-container {
    position: relative;
}

.filter-popover {
    position: absolute;
    top: calc(100% + 0.5rem);
    left: 0;
    z-index: 50;
    min-width: 200px;
    background-color: #fff;
    border-radius: 0.5rem;
    border: 1px solid #e2e8f0;
    box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1);
    overflow: hidden;
    animation: fadeIn 0.1s ease-out;
}
@keyframes fadeIn {
    from { opacity: 0; transform: translateY(-5px); }
    to { opacity: 1; transform: translateY(0); }
}

.filter-popover-list {
    list-style: none;
    margin: 0;
    padding: 0.5rem;
    max-height: 250px;
    overflow-y: auto;
}

.filter-popover-list li {
    padding: 0.5rem 0.75rem;
    font-size: 0.875rem;
    color: #374151;
    cursor: pointer;
    border-radius: 0.375rem;
    transition: background-color 0.2s;
}
.filter-popover-list li:hover {
    background-color: #f3f4f6;
}

.advanced-filters-content {
    background-color: #fff;
    border: 1px solid #e2e8f0;
    border-radius: 0.5rem;
    padding: 1.5rem;
    margin-top: 0.5rem;
}

.advanced-filters-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 1.5rem;
    align-items: end;
}
.advanced-filters-actions {
    display: flex;
    justify-content: flex-end;
    margin-top: 1.5rem;
    padding-top: 1.5rem;
    border-top: 1px solid #e2e8f0;
}

.filter-group {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
}
.filter-group label {
    font-size: 0.875rem;
    font-weight: 500;
    color: #374151;
}
.filter-group input,
.filter-group select {
    font-size: 0.875rem;
    padding: 0.5rem 0.75rem;
    border-radius: 0.5rem;
    border: 1px solid #d1d5db;
    background-color: #fff;
}

.date-inputs {
    display: flex;
    align-items: center;
    gap: 0.5rem;
}

.table-actions-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.75rem;
    padding: 1rem;
    background-color: #fff;
    border: 1px solid #e2e8f0;
    border-radius: 0.75rem;
}
.table-actions-left, .table-actions-right {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
}

/* ============================================= */
/* COMPONENTES DE UI                */
/* ============================================= */
.btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    white-space: nowrap;
    border-radius: 0.5rem;
    font-size: 0.875rem;
    font-weight: 500;
    padding: 0.5rem 1rem;
    cursor: pointer;
    transition: all 0.2s;
    border: 1px solid transparent;
}
.btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
}

.btn-primary {
    background-color: #1e293b;
    color: #fff;
    border-color: #1e293b;
}
.btn-primary:hover:not(:disabled) {
    background-color: #334155;
}

.btn-secondary {
    background-color: #e2e8f0;
    color: #1e293b;
    border-color: #e2e8f0;
}
.btn-secondary:hover:not(:disabled) {
    background-color: #d1d5db;
}

.btn-outline {
    background-color: #fff;
    color: #374151;
    border-color: #d1d5db;
}
.btn-outline:hover:not(:disabled) {
    background-color: #f9fafb;
    border-color: #9ca3af;
}

.btn-ghost {
    background-color: transparent;
    color: #374151;
    border-color: transparent;
}
.btn-ghost:hover:not(:disabled) {
    background-color: #f3f4f6;
}

/* ============================================= */
/* ESTILOS LEGADOS                   */
/* ============================================= */
.main-container {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
}
.sales-table-container { background-color: #fff; border-radius: 0.75rem; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1); overflow: hidden; }
.table-wrapper { width: 100%; overflow-x: auto; }
.sales-table { width: 100%; min-width: 1450px; border-collapse: collapse; }
.sales-table th, .sales-table td { padding: 1rem 1.25rem; border-bottom: 1px solid #e5e7eb; text-align: left; white-space: nowrap; }
.sales-table th { background-color: #f9fafb; font-weight: 600; color: #4b5563; text-transform: uppercase; font-size: 0.75rem; }
.sales-table tbody tr:hover { background-color: #f3f4f6; }
.product-title, .sku-cell { max-width: 250px; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
.channel-badge.ml { background-color: #ffe600; color: #333; padding: 0.25rem 0.6rem; font-size: 0.75rem; font-weight: 500; border-radius: 9999px; }
.status-badge { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
.status-badge-default { background-color: #d1d5db; }
.status-badge-green { background-color: #22c55e; }
.status-badge-yellow { background-color: #f59e0b; }
.status-badge-red { background-color: #ef4444; }
.status-badge-gray { background-color: #6b7280; }
.status-badge-indigo { background-color: #6366f1; }
.status-badge-purple { background-color: #8b5cf6; }
.status-badge-cyan { background-color: #06b6d4; }
.status-badge-orange { background-color: #f97316; }
.pagination-controls { display: flex; justify-content: center; align-items: center; gap: .75rem; padding: 1rem; border-top: 1px solid #e5e7eb; }
.pagination-controls button { padding: .5rem .9rem; border: 1px solid #e5e7eb; border-radius: .5rem; background-color: #ffffff; cursor: pointer; }
.pagination-controls button:disabled { opacity: .5; cursor: not-allowed; }
.loading-state, .error-state, .empty-state { text-align: center; padding: 4rem 2rem; color: #6b7280; }
.empty-state-title { font-size: 1.25rem; font-weight: 600; color: #111827; }
.custom-tooltip { position: fixed; background-color: #1f2937; color: #fff; padding: 0.6rem 0.8rem; border-radius: 0.5rem; font-size: 0.8rem; z-index: 1000; pointer-events: none; visibility: hidden; opacity: 0; }
.tooltip-arrow { position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%); width: 0; height: 0; border-left: 6px solid transparent; border-right: 6px solid transparent; border-bottom: 6px solid #1f2937; }
.tag { padding: 0.2rem 0.6rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 600; }
.tag.processed { background-color: #dcfce7; color: #166534; }
.tag.unprocessed { background-color: #fee2e2; color: #991b1b; }
.modal-actions { display: flex; justify-content: flex-end; gap: 0.75rem; margin-top: 1.5rem; }
.summary-modal-content .error-text { background-color: #fee2e2; color: #991b1b; padding: 0.75rem; border-radius: 0.5rem; }
.status-select-trigger.compact { display: inline-flex; align-items: center; gap: 0.5rem; padding: 0.25rem 0.5rem; border: 1px solid transparent; border-radius: .375rem; }
.cancelled-sale { background-color: #fee2e2 !important; }
.cancelled-sale:hover { background-color: #fecaca !important; }
.label-actions { display: flex; gap: 0.5rem; align-items: center; justify-content: center; }
.btn-label { display: inline-flex; align-items: center; gap: 0.25rem; padding: 0.25rem 0.5rem; font-size: 0.75rem; font-weight: 500; border: 1px solid; border-radius: 0.375rem; cursor: pointer; transition: all 0.2s; text-decoration: none; }
.btn-label.pdf { background-color: #fef2f2; border-color: #fecaca; color: #dc2626; }
.btn-label.pdf:hover { background-color: #fee2e2; border-color: #fca5a5; }
.btn-label.zpl { background-color: #f0f9ff; border-color: #bae6fd; color: #0284c7; }
.btn-label.zpl:hover { background-color: #e0f2fe; border-color: #7dd3fc; }
.btn-label svg { width: 12px; height: 12px; }
.label-unavailable { color: #9ca3af; font-size: 0.875rem; }
</style>

