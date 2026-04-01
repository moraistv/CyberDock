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
                        <input type="text" v-model="searchQuery" placeholder="Buscar por produto, SKU, conta..."
                            class="search-input">
                    </div>

                    <!-- Filtro rápido: Status da Venda -->
                    <div class="filter-container" ref="saleStatusFilterContainerRef">
                        <button @click="toggleSaleStatusDropdown" class="btn btn-outline">
                            <span class="truncate pr-2">{{ selectedSaleStatusFilter ? `Venda:
                                ${getSaleStatusLabel(selectedSaleStatusFilter)}` : 'Status da Venda' }}</span>
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24" fill="none"
                                stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                                class="h-4 w-4 shrink-0 opacity-50">
                                <path d="m6 9 6 6 6-6"></path>
                            </svg>
                        </button>
                        <div v-if="isSaleStatusDropdownOpen" ref="saleStatusFilterDropdownRef" class="filter-popover">
                            <ul class="filter-popover-list">
                                <li @click="applySaleStatusFilter(null)">
                                    <span :class="{ 'font-bold': !selectedSaleStatusFilter }">Todos</span>
                                </li>
                                <li v-for="status in saleStatusOptions" :key="status.value"
                                    @click="applySaleStatusFilter(status.value)">
                                    <span :class="{ 'font-bold': selectedSaleStatusFilter === status.value }">{{
                                        status.label }}</span>
                                </li>
                            </ul>
                        </div>
                    </div>

                    <!-- Filtro rápido: Status de Expedição -->
                    <div class="filter-container" ref="statusFilterContainerRef">
                        <button @click="toggleStatusDropdown" class="btn btn-outline">
                            <span class="truncate pr-2">{{ selectedStatusFilter ? `Expedição:
                                ${getStatusLabel(selectedStatusFilter)}` : 'Status de Expedição' }}</span>
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24" fill="none"
                                stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                                class="h-4 w-4 shrink-0 opacity-50">
                                <path d="m6 9 6 6 6-6"></path>
                            </svg>
                        </button>
                        <div v-if="isStatusDropdownOpen" ref="statusFilterDropdownRef" class="filter-popover">
                            <ul class="filter-popover-list">
                                <li @click="applyStatusFilter(null)">
                                    <span :class="{ 'font-bold': !selectedStatusFilter }">Todos</span>
                                </li>
                                <li v-for="status in systemStatuses" :key="status.value"
                                    @click="applyStatusFilter(status.value)">
                                    <span :class="{ 'font-bold': selectedStatusFilter === status.value }">{{
                                        status.label
                                    }}</span>
                                </li>
                            </ul>
                        </div>
                    </div>

                    <!-- Filtro rápido: Conta -->
                    <div class="filter-container" ref="accountFilterContainerRef">
                        <button @click="toggleAccountDropdown" class="btn btn-outline">
                            <span class="truncate pr-2">{{ selectedAccountNickname }}</span>
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24" fill="none"
                                stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                                class="h-4 w-4 shrink-0 opacity-50">
                                <path d="m6 9 6 6 6-6"></path>
                            </svg>
                        </button>
                        <div v-if="isAccountDropdownOpen" ref="accountFilterDropdownRef" class="filter-popover">
                            <ul class="filter-popover-list">
                                <li @click="applyAccountFilter(null)">
                                    <span :class="{ 'font-bold': !selectedAccountFilterId }">Todas as Contas</span>
                                </li>
                                <li v-if="isLoadingAccounts">Carregando...</li>
                                <li v-for="account in mlAccounts" :key="account.user_id"
                                    @click="applyAccountFilter(account.user_id)">
                                    <span :class="{ 'font-bold': selectedAccountFilterId === account.user_id }">{{
                                        account.nickname }}</span>
                                </li>
                            </ul>
                        </div>
                    </div>

                </div>
                <div class="filters-right-group">
                    <!-- Botão para Filtros Avançados -->
                    <button @click="toggleAdvancedFilters" class="btn btn-ghost">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24" fill="none"
                            stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                            class="mr-2 h-4 w-4">
                            <path d="M3 6h18M7 12h10M10 18h4"></path>
                        </svg>
                        Filtros Avançados
                    </button>
                    <button @click="handleUnifiedSync" :class="['btn', 'sync-btn', 'btn-primary']"
                        :disabled="syncState.isSyncing || isLoadingAccounts" title="Clique para sincronizar vendas">
                        <svg v-if="syncState.isSyncing" class="animate-spin -ml-1 mr-2 h-4 w-4 inline-block"
                            xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4">
                            </circle>
                            <path class="opacity-75" fill="currentColor"
                                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z">
                            </path>
                        </svg>
                        <span v-if="syncState.isSyncing">Sincronizando...</span>
                        <span v-else>Sincronizar</span>

                        <span v-if="syncState.newSalesCount > 0" class="new-sales-badge">
                            {{ syncState.newSalesCount }}
                        </span>
                    </button>
                </div>
            </div>

            <!-- Filtros Avançados -->
            <div v-if="showAdvancedFilters" class="advanced-filters-content">
                <div class="advanced-filters-grid">
                    <!-- Filtro de Conta ML -->
                    <div class="filter-group">
                        <label for="conta-ml-filter">Conta ML</label>
                        <select id="conta-ml-filter" v-model="filters.accountId" :disabled="isLoadingAccounts">
                            <option :value="null">Todas as Contas</option>
                            <option v-for="account in mlAccounts" :key="account.user_id" :value="account.user_id">
                                {{ account.nickname }}
                            </option>
                        </select>
                    </div>

                    <!-- Filtro de Tipo de Expedição -->
                    <div class="filter-group">
                        <label for="shipping-type-filter">Tipo de Expedição</label>
                        <select id="shipping-type-filter" v-model="filters.shippingType">
                            <option :value="null">Todos os Tipos</option>
                            <option v-for="type in shippingTypeOptions" :key="type.value" :value="type.value">
                                {{ type.label }}
                            </option>
                        </select>
                    </div>

                    <!-- Filtro de Data da Venda -->
                    <div class="filter-group date-range-group">
                        <label for="sale-date-start">Data da Venda</label>
                        <div class="date-inputs">
                            <input id="sale-date-start" type="date" v-model="filters.saleDateStart">
                            <span>até</span>
                            <input id="sale-date-end" type="date" v-model="filters.saleDateEnd">
                        </div>
                        <div class="period-buttons">
                            <button @click="setSaleDatePeriod('yesterday')" class="period-btn">Ontem</button>
                            <button @click="setSaleDatePeriod('today')" class="period-btn">Hoje</button>
                            <button @click="setSaleDatePeriod('tomorrow')" class="period-btn">Amanhã</button>
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
                        <div class="period-buttons">
                            <button @click="setShippingLimitPeriod('yesterday')" class="period-btn">Ontem</button>
                            <button @click="setShippingLimitPeriod('today')" class="period-btn">Hoje</button>
                            <button @click="setShippingLimitPeriod('tomorrow')" class="period-btn">Amanhã</button>
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
                    <button @click="processSelectedSales" class="btn btn-primary"
                        :disabled="isProcessing || selectedCount === 0" title="Processar apenas as vendas selecionadas">
                        <span v-if="isProcessing">Processando...</span>
                        <span v-else>Processar Selecionadas ({{ selectedCount }})</span>
                    </button>
                    <button @click="processAllSales" class="btn btn-secondary" :disabled="isProcessing"
                        title="Processar automaticamente as vendas elegíveis da página atual">
                        <span v-if="isProcessing">Processando...</span>
                        <span v-else>Processar Página (auto)</span>
                    </button>
                    <button @click="openBulkStatusModal" class="btn btn-secondary" :disabled="selectedCount === 0"
                        title="Alterar o status de expedição para todas as selecionadas">
                        Alterar Expedição (Em massa)
                    </button>
                </div>
                <div class="table-actions-right">
                    <button @click="checkAllLabelsAvailability" class="btn btn-outline" :disabled="isCheckingLabels"
                        title="Verificar disponibilidade de todas as etiquetas">
                        <svg v-if="isCheckingLabels" class="animate-spin -ml-1 mr-2 h-4 w-4 inline-block"
                            xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4">
                            </circle>
                            <path class="opacity-75" fill="currentColor"
                                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z">
                            </path>
                        </svg>
                        <span v-if="isCheckingLabels">Verificando...</span>
                        <span v-else>Verificar Etiquetas</span>
                    </button>
                    <button @click="toggleAutoCheck"
                        :class="['btn', isAutoCheckEnabled ? 'btn-success' : 'btn-secondary']"
                        :title="isAutoCheckEnabled ? 'Desativar verificação automática' : 'Ativar verificação automática'">
                        <span v-if="isAutoCheckEnabled">Auto Verificação: ON</span>
                        <span v-else>Auto Verificação: OFF</span>
                    </button>
                </div>
            </div>
        </div>


        <!-- Indicador de Status da Verificação Automática -->
        <div v-if="isAutoCheckEnabled" class="auto-check-status">
            <div class="status-indicator">
                <div class="status-dot" :class="{ 'pulsing': autoCheckStatus === 'Verificando...' }"></div>
                <span class="status-text">{{ autoCheckStatus }}</span>
                <span v-if="lastAutoCheck" class="last-check">
                    Última verificação: {{ lastAutoCheck.toLocaleTimeString() }}
                </span>
                <span v-if="autoCheckCount > 0" class="check-count">
                    ({{ autoCheckCount }} verificações)
                </span>
            </div>
        </div>

        <!-- Container da Tabela de Vendas -->
        <div class="sales-table-container">
            <div v-if="isLoading" class="loading-state">
                <p>Carregando vendas...</p>
            </div>
            <div v-else-if="error" class="error-state">
                <p>{{ error }}</p>
            </div>
            <div v-else-if="sales.length === 0" class="empty-state">
                <h3 class="empty-state-title">Nenhuma venda encontrada</h3>
                <p class="empty-state-text">Parece que ainda não há vendas para este usuário.</p>
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
                                <th style="width:40px">
                                    <input type="checkbox" :checked="allSelectedOnPage"
                                        @change="toggleSelectAllOnPage($event.target.checked)"
                                        :title="allSelectedOnPage ? 'Desmarcar todos' : 'Selecionar todos da página'" />
                                </th>
                                <th>Canal</th>
                                <th>Conta</th>
                                <th>Cliente</th>
                                <th>Nickname</th>
                                <th>ID da Venda</th>
                                <th>Data da Venda</th>
                                <th>Produto</th>
                                <th>SKU</th>
                                <th>Qtd.</th>
                                <th>Modo Envio</th>
                                <th>Processada</th>
                                <th>Gerenciar SKU</th>
                                <th>Data Limite</th>
                                <th>Etiquetas</th>
                                <th>Ações</th>
                            </tr>
                        </thead>
                        <tbody ref="salesTableBodyRef">
                            <tr v-for="sale in paginatedUserSales" :key="`${sale.id}-${sale.sku}`" :class="{
                                'cancelled-sale': userRole === 'master' && (sale.raw_api_data?.status === 'cancelled'),
                                'unprocessed-sale': !sale.processed_at
                            }">
                                <td>
                                    <input type="checkbox" :checked="isSaleSelected(sale)"
                                        @change="toggleSelectSale(sale, $event.target.checked)"
                                        title="Selecionar venda" />
                                </td>
                                <td data-label="Canal"><span class="channel-badge ml">{{ sale.channel }}</span></td>
                                <td data-label="Conta">{{ sale.account_nickname }}</td>
                                <td data-label="Cliente" class="customer-name-cell"
                                    @mouseenter="showTooltip($event, getCustomerName(sale))" @mouseleave="hideTooltip">
                                    {{ getCustomerName(sale) }}
                                </td>
                                <td data-label="Nickname" class="buyer-nickname-cell"
                                    @mouseenter="showTooltip($event, getBuyerNickname(sale))" @mouseleave="hideTooltip">
                                    {{ getBuyerNickname(sale) }}
                                </td>
                                <td data-label="ID da Venda" class="sale-id-cell" @click="copySaleId(sale.id)"
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
                                        :title="`Processado em: ${formatDateTime(sale.processed_at)}`">
                                        Processada
                                    </span>
                                    <span v-else class="tag unprocessed" title="Esta venda ainda não foi processada">
                                        Pendente
                                    </span>
                                </td>

                                <td data-label="Gerenciar SKU">
                                    <span v-if="stockSkuSet.has(normalizeSku(sale.sku))" class="tag processed"
                                        :title="`SKU ${normalizeSku(sale.sku) || 'N/A'} está cadastrado no estoque`">Sim</span>
                                    <span v-else class="tag unprocessed"
                                        :title="`SKU ${normalizeSku(sale.sku) || 'N/A'} não encontrado no estoque`">Não</span>
                                </td>

                                <td data-label="Data Limite">{{
                                    formatDateTime(sale.raw_api_data?.sla_data?.expected_date
                                        ||
                                        sale.shipping_limit_date) }}</td>
                                <td data-label="Etiquetas">
                                    <div class="label-actions">
                                        <div class="label-button-group">
                                            <button v-if="getRealLabelStatus(sale).canDownload"
                                                @click="downloadShippingLabel(sale, 'pdf')" class="btn-label pdf"
                                                :title="`Baixar Etiqueta PDF - ${getRealLabelStatus(sale).reason}`">
                                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                                                    stroke="currentColor" stroke-width="2">
                                                    <polyline points="6,9 6,2 18,2 18,9"></polyline>
                                                    <path
                                                        d="M6,18H4a2,2,0,0,1-2-2V11a2,2,0,0,1,2-2H20a2,2,0,0,1,2,2v5a2,2,0,0,1-2,2H18">
                                                    </path>
                                                    <polyline points="6,14 18,14 18,18 6,18"></polyline>
                                                </svg>
                                                PDF
                                            </button>
                                            <div v-else class="btn-label-disabled pdf"
                                                :title="`PDF - ${getRealLabelStatus(sale).reason}`">
                                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                                                    stroke="currentColor" stroke-width="2">
                                                    <polyline points="6,9 6,2 18,2 18,9"></polyline>
                                                    <path
                                                        d="M6,18H4a2,2,0,0,1-2-2V11a2,2,0,0,1,2-2H20a2,2,0,0,1,2,2v5a2,2,0,0,1-2,2H18">
                                                    </path>
                                                    <polyline points="6,14 18,14 18,18 6,18"></polyline>
                                                </svg>
                                                PDF
                                            </div>
                                        </div>

                                        <div class="label-button-group">
                                            <button v-if="getRealLabelStatus(sale).canDownload"
                                                @click="downloadShippingLabel(sale, 'zpl')" class="btn-label zpl"
                                                :title="`Baixar Etiqueta ZPL - ${getRealLabelStatus(sale).reason}`">
                                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                                                    stroke="currentColor" stroke-width="2">
                                                    <polyline points="6,9 6,2 18,2 18,9"></polyline>
                                                    <path
                                                        d="M6,18H4a2,2,0,0,1-2-2V11a2,2,0,0,1,2-2H20a2,2,0,0,1,2,2v5a2,2,0,0,1-2,2H18">
                                                    </path>
                                                    <polyline points="6,14 18,14 18,18 6,18"></polyline>
                                                </svg>
                                                ZPL
                                            </button>
                                            <div v-else class="btn-label-disabled zpl"
                                                :title="`ZPL - ${getRealLabelStatus(sale).reason}`">
                                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                                                    stroke="currentColor" stroke-width="2">
                                                    <polyline points="6,9 6,2 18,2 18,9"></polyline>
                                                    <path
                                                        d="M6,18H4a2,2,0,0,1-2-2V11a2,2,0,0,1,2-2H20a2,2,0,0,1,2,2v5a2,2,0,0,1-2,2H18">
                                                    </path>
                                                    <polyline points="6,14 18,14 18,18 6,18"></polyline>
                                                </svg>
                                                ZPL
                                            </div>
                                        </div>

                                        <div class="label-button-group">
                                            <button v-if="getLabelInfo(sale).canPrint"
                                                @click="checkSingleLabelAvailability(sale)" class="btn-label check"
                                                :title="`Verificar disponibilidade da etiqueta`"
                                                :disabled="isCheckingSingleLabel">
                                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                                                    stroke="currentColor" stroke-width="2">
                                                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                                                    <polyline points="22,4 12,14.01 9,11.01"></polyline>
                                                </svg>
                                                Verificar
                                            </button>
                                            <button @click="debugLabelAvailability(sale)" class="btn-label debug"
                                                :title="`Debug detalhado da etiqueta`">
                                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                                                    stroke="currentColor" stroke-width="2">
                                                    <circle cx="12" cy="12" r="10"></circle>
                                                    <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path>
                                                    <line x1="12" y1="17" x2="12.01" y2="17"></line>
                                                </svg>
                                                Debug
                                            </button>
                                            <div class="label-indicator" :class="getRealLabelStatus(sale).status"
                                                :data-tooltip="getRealLabelStatus(sale).reason"
                                                :title="getRealLabelStatus(sale).reason">
                                                <span class="indicator-dot"></span>
                                            </div>
                                        </div>
                                    </div>
                                </td>
                                <td data-label="Ações">
                                    <button class="status-select-trigger" @click="openStatusModal(sale)">
                                        <div class="status-cell">
                                            <span
                                                :class="['status-badge', getStatusColorClass(sale.shipping_status)]"></span>
                                            <span>{{ getStatusLabel(sale.shipping_status) }}</span>
                                        </div>
                                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24"
                                            fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
                                            stroke-linejoin="round" class="status-arrow">
                                            <polyline points="6 9 12 15 18 9"></polyline>
                                        </svg>
                                    </button>
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

        <UniversalModal :is-open="isStatusModalOpen" title="Alterar Status do Envio" @close="closeStatusModal">
            <div class="status-modal-content" v-if="selectedSaleForStatusChange">
                <p class="status-modal-intro">
                    Selecione o novo status para o pedido: <strong class="status-modal-product-title">{{
                        selectedSaleForStatusChange.product_title }}</strong>
                </p>
                <ul class="status-selection-list">
                    <li v-for="status in systemStatuses" :key="status.value" @click="selectNewStatus(status.value)">
                        <div class="status-cell">
                            <span :class="['status-badge', getStatusColorClass(status.value)]"></span>
                            <span>{{ status.label }}</span>
                        </div>
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24" fill="none"
                            stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"
                            class="status-selection-arrow">
                            <polyline points="9 18 15 12 9 6"></polyline>
                        </svg>
                    </li>
                </ul>
            </div>
        </UniversalModal>

        <UniversalModal :is-open="isSummaryModalOpen" :title="summaryModalTitle" @close="isSummaryModalOpen = false">
            <div class="summary-modal-content" v-html="summaryModalContent"></div>
            <div class="modal-actions">
                <button @click="isSummaryModalOpen = false" class="btn btn-primary">Fechar</button>
            </div>
        </UniversalModal>

        <!-- Modal de alteração em massa do Status de Expedição -->
        <UniversalModal :is-open="isBulkStatusModalOpen" title="Alterar Status do Envio (Em massa)"
            @close="isBulkStatusModalOpen = false">
            <div class="status-modal-content" v-if="selectedCount > 0">
                <p class="status-modal-intro">
                    Selecione o novo status para <strong>{{ selectedCount }}</strong> venda(s) selecionada(s).
                </p>
                <ul class="status-selection-list">
                    <li v-for="status in systemStatuses" :key="status.value" @click="applyBulkStatus(status.value)">
                        <div class="status-cell">
                            <span :class="['status-badge', getStatusColorClass(status.value)]"></span>
                            <span>{{ status.label }}</span>
                        </div>
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24" fill="none"
                            stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"
                            class="status-selection-arrow">
                            <polyline points="9 18 15 12 9 6"></polyline>
                        </svg>
                    </li>
                </ul>
            </div>
        </UniversalModal>

        <ToastNotification :is-visible="syncState.isVisible" :title="syncState.title"
            :description="syncState.description" :progress="syncState.progress" :type="syncState.type" />
    </div>
</template>

<script setup>
import { defineProps, ref, onMounted, onUnmounted, computed, watch, nextTick, toRefs, reactive } from 'vue';
import gsap from 'gsap';
import { useSalesForUser } from '@/composables/useSalesForUser';
import { useUserStorage } from '@/composables/useUserStorage';
import { useSystemStatus } from '@/composables/useSystemStatus';
import { useLabels } from '@/composables/useLabels';
import UniversalModal from './UniversalModal.vue';
import ToastNotification from './ToastNotification.vue';
import { useUserAccounts } from '@/composables/useUserAccounts';
import { useSyncManager } from '@/composables/useSyncManager';
import { useAuth } from '@/composables/useAuth';



const props = defineProps({
    userId: { type: String, required: true },
});
const userIdRef = toRefs(props).userId;

const { accounts: mlAccounts, isLoading: isLoadingAccounts } = useUserAccounts(userIdRef);
const { syncState, syncAccount, enrichExistingSales } = useSyncManager();

const { sales, isLoading, error, fetchSales, updateSaleStatus, processSales: processSalesApi } = useSalesForUser(userIdRef);
const { skus, loadStorageData } = useUserStorage(userIdRef);
const { systemStatuses } = useSystemStatus();
const { getLabelInfo, downloadLabel, checkLabelAvailability } = useLabels();
const { userRole } = useAuth();

const salesTableBodyRef = ref(null);
const tooltipRef = ref(null);
let hideTooltipTimeout = null;
const salesCurrentPage = ref(1);
const salesItemsPerPage = ref(7);
const isStatusModalOpen = ref(false);
const selectedSaleForStatusChange = ref(null);
const isProcessing = ref(false);
const isCheckingLabels = ref(false);
const isCheckingSingleLabel = ref(false);
const isSummaryModalOpen = ref(false);
const summaryModalTitle = ref('');
const summaryModalContent = ref('');
const isBulkStatusModalOpen = ref(false);

// Seleção de vendas para processamento manual
const selectedSaleKeys = ref(new Set());
const saleKey = (s) => `${s.id}-${s.sku}`;
const isSaleSelectable = (sale) => {
    const saleSku = normalizeSku(sale.sku);
    const gerenciarSkuSim = saleSku && stockSkuSet.value.has(saleSku);
    return !sale.processed_at && gerenciarSkuSim;
};
const isSaleSelected = (sale) => selectedSaleKeys.value.has(saleKey(sale));
const selectedCount = computed(() => selectedSaleKeys.value.size);
const toggleSelectSale = (sale, checked) => {
    const key = saleKey(sale);
    const next = new Set(selectedSaleKeys.value);
    if (checked) {
        if (isSaleSelectable(sale)) next.add(key);
    } else {
        next.delete(key);
    }
    selectedSaleKeys.value = next;
};
const allSelectedOnPage = computed(() => {
    const rows = paginatedUserSales.value;
    if (rows.length === 0) return false;
    return rows.every((s) => selectedSaleKeys.value.has(saleKey(s)));
});
const toggleSelectAllOnPage = (checked) => {
    const next = new Set(selectedSaleKeys.value);
    paginatedUserSales.value.forEach((s) => {
        const key = saleKey(s);
        if (checked) {
            next.add(key);
        } else {
            next.delete(key);
        }
    });
    selectedSaleKeys.value = next;
};

const selectedSales = computed(() => {
    const set = new Set(selectedSaleKeys.value);
    return sales.value.filter((s) => set.has(saleKey(s)));
});

function openBulkStatusModal() {
    if (selectedCount.value === 0) {
        summaryModalTitle.value = 'Nenhuma venda selecionada';
        summaryModalContent.value = '<p>Selecione ao menos uma venda para alterar o status de expedição em massa.</p>';
        isSummaryModalOpen.value = true;
        return;
    }
    isBulkStatusModalOpen.value = true;
}

// Estado para rastrear a disponibilidade real das etiquetas
const labelAvailabilityCache = ref(new Map());

// Sistema de verificação automática em tempo real
const autoCheckInterval = ref(null);
const isAutoCheckEnabled = ref(true);
const lastAutoCheck = ref(null);
const autoCheckStatus = ref('Parado');
const autoCheckCount = ref(0);

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

const selectedAccountFilterId = ref(null);
const isAccountDropdownOpen = ref(false);
const accountFilterContainerRef = ref(null);
const accountFilterDropdownRef = ref(null);

const filters = reactive({
    accountId: null,
    saleDateStart: '',
    saleDateEnd: '',
    shippingLimitStart: '',
    shippingLimitEnd: '',
    saleStatus: null,
    shippingType: null,
    shippingStatus: null,
});

const normalizeSku = (sku) => (sku || '').trim().toUpperCase();

function toLocalDateInputValue(date) {
    const d = new Date(date);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function parseFlexibleDate(value, { endOfDay = false } = {}) {
    if (!value) return null;
    let d = null;
    if (value instanceof Date) { d = new Date(value); }
    else if (typeof value === 'number') { d = new Date(value); }
    else if (typeof value === 'string') {
        const str = value.trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
            const [y, m, day] = str.split('-').map(Number);
            d = new Date(y, m - 1, day, 0, 0, 0, 0);
        } else {
            d = new Date(str);
        }
    }
    if (!d || isNaN(d)) return null;
    if (endOfDay) d.setHours(23, 59, 59, 999);
    return d;
}

const getSaleAccountId = (s) => s?.seller_id ?? s?.account_user_id ?? s?.account_id ?? s?.sellerId ?? s?.accountUserId ?? s?.accountId ?? s?.account?.user_id ?? null;
const normalizeId = (id) => (id === null || id === undefined ? null : String(id));

const stockSkuSet = computed(() => {
    if (!Array.isArray(skus.value)) return new Set();
    return new Set(skus.value.map(s => normalizeSku(s.sku)));
});

const selectedAccountNickname = computed(() => {
    const id = selectedAccountFilterId.value;
    if (!id) return 'Todas as Contas';
    const acc = (mlAccounts.value || []).find(a => String(a.user_id) === String(id));
    return acc?.nickname ?? 'Conta';
});

const filteredUserSales = computed(() => {
    let tempSales = sales.value;

    if (selectedStatusFilter.value) {
        tempSales = tempSales.filter(s => s.shipping_status === selectedStatusFilter.value);
    }

    if (selectedSaleStatusFilter.value) {
        tempSales = tempSales.filter(s => {
            const saleStatus = s?.raw_api_data?.status || s?.sale_status || null;
            return saleStatus === selectedSaleStatusFilter.value;
        });
    }

    if (searchQuery.value) {
        const query = searchQuery.value.toLowerCase();
        tempSales = tempSales.filter(s =>
            (s.product_title?.toLowerCase().includes(query)) ||
            (s.sku?.toLowerCase().includes(query)) ||
            (s.account_nickname?.toLowerCase().includes(query))
        );
    }

    if (selectedAccountFilterId.value) {
        const sel = normalizeId(selectedAccountFilterId.value);
        tempSales = tempSales.filter(s => normalizeId(getSaleAccountId(s)) === sel);
    }

    if (filters.saleDateStart) {
        const start = parseFlexibleDate(filters.saleDateStart);
        tempSales = tempSales.filter(s => {
            const saleDate = parseFlexibleDate(s.sale_date);
            return saleDate && start && saleDate >= start;
        });
    }
    if (filters.saleDateEnd) {
        const end = parseFlexibleDate(filters.saleDateEnd, { endOfDay: true });
        tempSales = tempSales.filter(s => {
            const saleDate = parseFlexibleDate(s.sale_date);
            return saleDate && end && saleDate <= end;
        });
    }

    if (filters.shippingLimitStart) {
        const start = parseFlexibleDate(filters.shippingLimitStart);
        tempSales = tempSales.filter(s => {
            const raw = s.raw_api_data?.sla_data?.expected_date || s.shipping_limit_date;
            const limitDate = parseFlexibleDate(raw);
            return limitDate && start && limitDate >= start;
        });
    }
    if (filters.shippingLimitEnd) {
        const end = parseFlexibleDate(filters.shippingLimitEnd, { endOfDay: true });
        tempSales = tempSales.filter(s => {
            const raw = s.raw_api_data?.sla_data?.expected_date || s.shipping_limit_date;
            const limitDate = parseFlexibleDate(raw);
            return limitDate && end && limitDate <= end;
        });
    }

    // Novos filtros avançados
    if (filters.saleStatus) {
        tempSales = tempSales.filter(s => {
            const saleStatus = s?.raw_api_data?.status || s?.sale_status || null;
            return saleStatus === filters.saleStatus;
        });
    }

    if (filters.shippingType) {
        tempSales = tempSales.filter(s => s?.shipping_mode === filters.shippingType);
    }

    if (filters.shippingStatus) {
        tempSales = tempSales.filter(s => s.shipping_status === filters.shippingStatus);
    }

    return tempSales;
});

const salesTotalPages = computed(() => Math.ceil(filteredUserSales.value.length / salesItemsPerPage.value) || 1);
const paginatedUserSales = computed(() => {
    const startIndex = (salesCurrentPage.value - 1) * salesItemsPerPage.value;
    const paginated = filteredUserSales.value.slice(startIndex, startIndex + salesItemsPerPage.value);
    nextTick(() => {
        if (salesTableBodyRef.value?.children.length) {
            gsap.from(salesTableBodyRef.value.children, {
                opacity: 0, y: 20, duration: 0.5, stagger: 0.08, ease: 'power3.out'
            });
        }
    });
    return paginated;
});

watch([searchQuery, selectedSaleStatusFilter, selectedStatusFilter, filters, selectedAccountFilterId], () => { salesCurrentPage.value = 1; }, { deep: true });
watch(selectedAccountFilterId, (v) => { filters.accountId = v ?? null; });
watch(() => filters.accountId, (v) => { selectedAccountFilterId.value = v ?? null; });

// Sincronizar filtro rápido de status de expedição com filtro avançado
watch(selectedStatusFilter, (v) => { filters.shippingStatus = v ?? null; });
watch(() => filters.shippingStatus, (v) => { selectedStatusFilter.value = v ?? null; });

watch(() => syncState.value.isSyncing, (isSyncing, wasSyncing) => {
    if (wasSyncing && !isSyncing && syncState.value.progress === 100 && syncState.value.type !== 'error') {
        fetchSales();
    }
});


function formatDateTime(dateString) {
    if (!dateString) return 'N/A';
    const date = new Date(dateString);
    if (isNaN(date)) return 'Data inválida';
    return date.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}



// FUNÇÃO PARA BAIXAR ETIQUETAS ATUALIZADA COM TRATAMENTO DE ERRO
async function downloadShippingLabel(sale, type) {
    const info = getLabelInfo(sale);
    if (info.canPrint) {
        try {
            // Tenta fazer o download diretamente
            await downloadLabel(info.shipmentId, info.sellerId, type);

            // Se chegou até aqui, marca como disponível no cache
            const cacheKey = `${info.shipmentId}-${info.sellerId}`;
            labelAvailabilityCache.value.set(cacheKey, { available: true });

        } catch (error) {
            // Se ocorrer um erro, marca como indisponível no cache com detalhes
            const cacheKey = `${info.shipmentId}-${info.sellerId}`;
            labelAvailabilityCache.value.set(cacheKey, {
                available: false,
                reason: error.message || 'Erro ao baixar etiqueta'
            });

            // Se ocorrer um erro, exibe um modal para o usuário.
            console.error("Erro no componente ao baixar etiqueta:", error);
            summaryModalTitle.value = 'Erro ao Baixar Etiqueta';

            // Melhora a mensagem de erro baseada no tipo de erro
            let errorMessage = error.message || 'Verifique a conexão e tente novamente.';
            if (error.message && error.message.includes('Etiqueta não disponível')) {
                errorMessage = 'Esta etiqueta não está disponível para download. Isso pode ocorrer quando o pedido já foi enviado ou cancelado.';
            }

            summaryModalContent.value = `
                <p>Não foi possível baixar a etiqueta.</p>
                <p class="error-text">${errorMessage}</p>
                <p><strong>Detalhes técnicos:</strong></p>
                <p class="error-text">Shipment ID: ${info.shipmentId}<br>
                Seller ID: ${info.sellerId}<br>
                Tipo: ${type.toUpperCase()}</p>
            `;
            isSummaryModalOpen.value = true;
        }
    } else {
        console.warn("Tentativa de baixar etiqueta para uma venda não permitida:", sale);
        summaryModalTitle.value = 'Etiqueta Não Disponível';
        summaryModalContent.value = `<p>Esta etiqueta não pode ser baixada.</p><p class="error-text">${info.reason}</p>`;
        isSummaryModalOpen.value = true;
    }
}

const getStatusLabel = (s) => (systemStatuses.value.find(cs => cs.value === s)?.label || s || 'Pendente').replace(/_/g, ' ');

// Função para verificar se a etiqueta está disponível baseado na data limite de envio
function isLabelAvailableByDate(sale) {
    const shippingLimitDate = sale.raw_api_data?.sla_data?.expected_date || sale.shipping_limit_date;
    if (!shippingLimitDate) {
        return {
            available: false,
            reason: 'Data limite de envio não informada'
        };
    }

    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0); // Zera as horas para comparar apenas a data

        // Tenta diferentes formatos de data para ser mais robusto
        let limitDate;
        if (typeof shippingLimitDate === 'string') {
            // Tenta parsear como ISO string primeiro
            limitDate = new Date(shippingLimitDate);
            if (isNaN(limitDate.getTime())) {
                // Se falhar, tenta como data brasileira (DD/MM/YYYY)
                const parts = shippingLimitDate.split('/');
                if (parts.length === 3) {
                    limitDate = new Date(parts[2], parts[1] - 1, parts[0]);
                } else {
                    // Se ainda falhar, tenta parsear como está
                    limitDate = new Date(shippingLimitDate);
                }
            }
        } else {
            limitDate = new Date(shippingLimitDate);
        }

        if (isNaN(limitDate.getTime())) {
            return {
                available: false,
                reason: `Data limite inválida: ${shippingLimitDate}`
            };
        }

        limitDate.setHours(0, 0, 0, 0);

        // Adiciona uma margem de tolerância de 1 dia para casos de timezone
        const toleranceMs = 24 * 60 * 60 * 1000; // 1 dia em milissegundos
        const isWithinTolerance = (limitDate.getTime() - today.getTime()) <= toleranceMs;

        // Verifica se a data limite já passou (considerando tolerância)
        if (limitDate < today && !isWithinTolerance) {
            const daysPast = Math.ceil((today - limitDate) / (1000 * 60 * 60 * 24));
            return {
                available: false,
                reason: `Prazo de emissão da etiqueta expirou há ${daysPast} dia${daysPast > 1 ? 's' : ''} (${limitDate.toLocaleDateString('pt-BR')})`
            };
        }

        if (limitDate > today && !isWithinTolerance) {
            const daysUntilShipping = Math.ceil((limitDate - today) / (1000 * 60 * 60 * 24));
            return {
                available: false,
                reason: `Etiqueta disponível apenas no dia ${limitDate.toLocaleDateString('pt-BR')} (${daysUntilShipping} dia${daysUntilShipping > 1 ? 's' : ''})`
            };
        }

        return {
            available: true,
            reason: 'Etiqueta disponível para download'
        };
    } catch (error) {
        console.warn('Erro ao verificar data limite de envio:', error, 'Data:', shippingLimitDate);
        return {
            available: false,
            reason: `Erro ao processar data limite: ${shippingLimitDate}`
        };
    }
}

// Função para obter o status real da etiqueta considerando data limite e cache
function getRealLabelStatus(sale) {
    const info = getLabelInfo(sale);

    if (!info.canPrint) {
        return {
            status: 'unavailable',
            reason: info.reason,
            canDownload: false
        };
    }

    // Primeiro verifica se está disponível por data
    const dateCheck = isLabelAvailableByDate(sale);
    if (!dateCheck.available) {
        return {
            status: 'date-unavailable',
            reason: dateCheck.reason,
            canDownload: false
        };
    }

    // Se passou na verificação de data, verifica o cache da API
    const cacheKey = `${info.shipmentId}-${info.sellerId}`;
    const cachedResult = labelAvailabilityCache.value.get(cacheKey);

    if (cachedResult && typeof cachedResult === 'object') {
        // Cache com objeto detalhado
        if (cachedResult.available === true) {
            return {
                status: 'available',
                reason: 'Etiqueta disponível',
                canDownload: true
            };
        } else {
            return {
                status: 'unavailable',
                reason: cachedResult.reason || 'Etiqueta não disponível na API',
                canDownload: false
            };
        }
    } else if (cachedResult === true) {
        // Cache booleano legado
        return {
            status: 'available',
            reason: 'Etiqueta disponível',
            canDownload: true
        };
    } else if (cachedResult === false) {
        // Cache booleano legado
        return {
            status: 'unavailable',
            reason: 'Etiqueta não disponível na API',
            canDownload: false
        };
    } else {
        // Não foi verificado ainda - mas passou na verificação de data
        return {
            status: 'unknown',
            reason: 'Etiqueta pode estar disponível - clique para verificar',
            canDownload: true
        };
    }
}

// Função para verificar disponibilidade da etiqueta em tempo real
async function checkLabelAvailabilityRealTime(sale) {
    const info = getLabelInfo(sale);

    if (!info.canPrint) {
        return {
            status: 'unavailable',
            reason: info.reason,
            canDownload: false
        };
    }

    // Primeiro verifica se está disponível por data
    const dateCheck = isLabelAvailableByDate(sale);
    if (!dateCheck.available) {
        return {
            status: 'date-unavailable',
            reason: dateCheck.reason,
            canDownload: false
        };
    }

    try {
        const availability = await checkLabelAvailability(info.shipmentId, info.sellerId);
        const cacheKey = `${info.shipmentId}-${info.sellerId}`;

        if (availability.available) {
            labelAvailabilityCache.value.set(cacheKey, { available: true });
            return {
                status: 'available',
                reason: 'Etiqueta disponível',
                canDownload: true
            };
        } else {
            labelAvailabilityCache.value.set(cacheKey, {
                available: false,
                reason: availability.reason
            });
            return {
                status: 'unavailable',
                reason: availability.reason,
                canDownload: false
            };
        }
    } catch (error) {
        console.warn('Erro ao verificar disponibilidade da etiqueta:', error);
        return {
            status: 'unknown',
            reason: 'Erro ao verificar disponibilidade - clique para tentar baixar',
            canDownload: true
        };
    }
}

// Função de debug individual para analisar uma venda específica
function debugLabelAvailability(sale) {
    console.group(`🔍 DEBUG ETIQUETA - Venda ${sale.id || 'N/A'}`);

    // Informações básicas da venda
    console.log('📋 INFORMAÇÕES BÁSICAS:');
    console.log('- ID da Venda:', sale.id);
    console.log('- Status da Venda:', sale.sale_status || sale.raw_api_data?.status || 'N/A');
    console.log('- Status de Expedição:', sale.shipping_status || 'N/A');
    console.log('- Processada em:', sale.processed_at || 'Não processada');
    console.log('- Data de Criação:', sale.created_at || 'N/A');

    // Dados do ML
    const raw = sale?.raw_api_data || {};
    console.log('🛒 DADOS DO MERCADO LIVRE:');
    console.log('- Seller ID:', sale?.seller_id ?? raw?.seller?.id ?? raw?.seller_id ?? 'N/A');
    console.log('- Shipment ID:', raw?.shipping?.id ?? raw?.shipment_id ?? sale?.shipment_id ?? 'N/A');
    console.log('- Status ML:', raw?.status || 'N/A');
    console.log('- Modo de Envio:', raw?.shipping?.mode || sale?.shipping_mode || 'N/A');

    // Data limite de envio
    const shippingLimitDate = raw?.sla_data?.expected_date || sale.shipping_limit_date;
    console.log('📅 DATA LIMITE DE ENVIO:');
    console.log('- Data:', shippingLimitDate || 'N/A');
    if (shippingLimitDate) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const limitDate = new Date(shippingLimitDate);
        limitDate.setHours(0, 0, 0, 0);
        const isToday = limitDate.getTime() === today.getTime();
        const isPast = limitDate < today;
        const isFuture = limitDate > today;
        console.log('- É hoje?', isToday);
        console.log('- É passado?', isPast);
        console.log('- É futuro?', isFuture);
    }

    // Verificações passo a passo
    console.log('🔍 VERIFICAÇÕES PASSO A PASSO:');

    // 1. Verificação de dados básicos
    const info = getLabelInfo(sale);
    console.log('1️⃣ Dados Básicos:');
    console.log('- Pode imprimir?', info.canPrint);
    console.log('- Motivo:', info.reason);
    console.log('- Shipment ID extraído:', info.shipmentId);
    console.log('- Seller ID extraído:', info.sellerId);

    // 2. Verificação de data
    const dateCheck = isLabelAvailableByDate(sale);
    console.log('2️⃣ Verificação de Data:');
    console.log('- Disponível por data?', dateCheck.available);
    console.log('- Motivo:', dateCheck.reason);

    // 3. Verificação de cache
    const cacheKey = `${info.shipmentId}-${info.sellerId}`;
    const cachedResult = labelAvailabilityCache.value.get(cacheKey);
    console.log('3️⃣ Verificação de Cache:');
    console.log('- Chave do cache:', cacheKey);
    console.log('- Resultado em cache:', cachedResult);

    // 4. Status final
    const finalStatus = getRealLabelStatus(sale);
    console.log('4️⃣ STATUS FINAL:');
    console.log('- Status:', finalStatus.status);
    console.log('- Motivo:', finalStatus.reason);
    console.log('- Pode baixar?', finalStatus.canDownload);

    // Identificação do cenário
    let scenario = 'CENÁRIO DESCONHECIDO';
    if (!sale.processed_at) {
        scenario = 'CENÁRIO 1: VENDA NÃO PROCESSADA';
    } else if (!info.canPrint) {
        if (!info.shipmentId || !info.sellerId) {
            scenario = 'CENÁRIO 4: DADOS BÁSICOS INVÁLIDOS';
        } else {
            scenario = 'CENÁRIO 3: STATUS DA VENDA IMPEDE IMPRESSÃO';
        }
    } else if (!dateCheck.available) {
        scenario = 'CENÁRIO 2: DATA LIMITE NÃO ATINGIDA';
    } else if (cachedResult === undefined || cachedResult === null) {
        scenario = 'CENÁRIO 5: ETIQUETAS NÃO VERIFICADAS';
    } else if (cachedResult === true || (cachedResult && cachedResult.available === true)) {
        scenario = 'CENÁRIO 6: ETIQUETAS DISPONÍVEIS';
    } else if (cachedResult === false || (cachedResult && cachedResult.available === false)) {
        scenario = 'CENÁRIO 7: ERROS DE API';
    }

    console.log('🎯 CENÁRIO IDENTIFICADO:', scenario);

    console.groupEnd();

    // Mostra modal com informações de debug
    summaryModalTitle.value = `Análise Detalhada da Etiqueta - Venda ${sale.id || 'N/A'}`;


    const debugInfo = `
        <div class="debug-modal">
            <div class="debug-section">
                <h3>Informações da Venda</h3>
                <table class="debug-table">
                    <tbody>
                        <tr>
                            <td class="table-label">ID da Venda</td>
                            <td class="table-value">${sale.id || 'Não informado'}</td>
                        </tr>
                        <tr>
                            <td class="table-label">Status da Venda</td>
                            <td class="table-value status-${sale.sale_status || sale.raw_api_data?.status ? 'normal' : 'missing'}">${sale.sale_status || sale.raw_api_data?.status || 'Não informado'}</td>
                        </tr>
                        <tr>
                            <td class="table-label">Status de Expedição</td>
                            <td class="table-value status-${sale.shipping_status ? 'normal' : 'missing'}">${sale.shipping_status || 'Não informado'}</td>
                        </tr>
                        <tr>
                            <td class="table-label">Processada em</td>
                            <td class="table-value status-${sale.processed_at ? 'normal' : 'missing'}">${sale.processed_at ? new Date(sale.processed_at).toLocaleString('pt-BR') : 'Não processada'}</td>
                        </tr>
                        <tr>
                            <td class="table-label">Data de Criação</td>
                            <td class="table-value">${sale.created_at ? new Date(sale.created_at).toLocaleString('pt-BR') : 'Não informado'}</td>
                        </tr>
                    </tbody>
                </table>
            </div>
            
            <div class="debug-section">
                <h3>Dados do Mercado Livre</h3>
                <table class="debug-table">
                    <tbody>
                        <tr>
                            <td class="table-label">Seller ID</td>
                            <td class="table-value status-${(sale?.seller_id ?? raw?.seller?.id ?? raw?.seller_id) ? 'normal' : 'missing'}">${sale?.seller_id ?? raw?.seller?.id ?? raw?.seller_id ?? 'Não encontrado'}</td>
                        </tr>
                        <tr>
                            <td class="table-label">Shipment ID</td>
                            <td class="table-value status-${(raw?.shipping?.id ?? raw?.shipment_id ?? sale?.shipment_id) ? 'normal' : 'missing'}">${raw?.shipping?.id ?? raw?.shipment_id ?? sale?.shipment_id ?? 'Não encontrado'}</td>
                        </tr>
                        <tr>
                            <td class="table-label">Status ML</td>
                            <td class="table-value status-${raw?.status ? 'normal' : 'missing'}">${raw?.status || 'Não informado'}</td>
                        </tr>
                        <tr>
                            <td class="table-label">Modo de Envio</td>
                            <td class="table-value">${raw?.shipping?.mode || sale?.shipping_mode || 'Não informado'}</td>
                        </tr>
                    </tbody>
                </table>
            </div>
            
            <div class="debug-section">
                <h3>Análise da Data Limite de Envio</h3>
                <table class="debug-table">
                    <tbody>
                        <tr>
                            <td class="table-label">Data limite</td>
                            <td class="table-value status-${shippingLimitDate ? 'normal' : 'missing'}">${shippingLimitDate ? new Date(shippingLimitDate).toLocaleDateString('pt-BR') : 'Não informada'}</td>
                        </tr>
                        ${shippingLimitDate ? `
                            <tr>
                                <td class="table-label">É hoje?</td>
                                <td class="table-value status-${(() => {
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                const limitDate = new Date(shippingLimitDate);
                limitDate.setHours(0, 0, 0, 0);
                return limitDate.getTime() === today.getTime();
            })() ? 'success' : 'normal'}">${(() => {
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                const limitDate = new Date(shippingLimitDate);
                limitDate.setHours(0, 0, 0, 0);
                return limitDate.getTime() === today.getTime();
            })() ? 'Sim' : 'Não'}</td>
                            </tr>
                            <tr>
                                <td class="table-label">É passado?</td>
                                <td class="table-value status-${(() => {
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                const limitDate = new Date(shippingLimitDate);
                limitDate.setHours(0, 0, 0, 0);
                return limitDate < today;
            })() ? 'success' : 'normal'}">${(() => {
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                const limitDate = new Date(shippingLimitDate);
                limitDate.setHours(0, 0, 0, 0);
                return limitDate < today;
            })() ? 'Sim' : 'Não'}</td>
                            </tr>
                            <tr>
                                <td class="table-label">É futuro?</td>
                                <td class="table-value status-${(() => {
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                const limitDate = new Date(shippingLimitDate);
                limitDate.setHours(0, 0, 0, 0);
                return limitDate > today;
            })() ? 'warning' : 'normal'}">${(() => {
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                const limitDate = new Date(shippingLimitDate);
                limitDate.setHours(0, 0, 0, 0);
                return limitDate > today;
            })() ? 'Sim' : 'Não'}</td>
                            </tr>
                        ` : ''}
                    </tbody>
                </table>
            </div>
            
            <div class="debug-section">
                <h3>Análise Técnica da Etiqueta</h3>
                <table class="debug-table">
                    <thead>
                        <tr>
                            <th class="table-header">Verificação</th>
                            <th class="table-header">Status</th>
                            <th class="table-header">Detalhes</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td class="table-label">Dados Básicos</td>
                            <td class="table-value status-${info.canPrint ? 'success' : 'error'}">${info.canPrint ? 'OK' : 'Falhou'}</td>
                            <td class="table-details">${info.reason}</td>
                        </tr>
                        <tr>
                            <td class="table-label">Verificação de Data</td>
                            <td class="table-value status-${dateCheck.available ? 'success' : 'error'}">${dateCheck.available ? 'OK' : 'Falhou'}</td>
                            <td class="table-details">${dateCheck.reason}</td>
                        </tr>
                        <tr>
                            <td class="table-label">Verificação de Cache</td>
                            <td class="table-value status-${cachedResult !== undefined ? 'normal' : 'missing'}">${cachedResult === undefined ? 'Não verificado' : 'Verificado'}</td>
                            <td class="table-details">${cachedResult === undefined ? 'Chave: ' + cacheKey : (typeof cachedResult === 'object' ? JSON.stringify(cachedResult) : cachedResult.toString())}</td>
                        </tr>
                        <tr>
                            <td class="table-label">Status Final</td>
                            <td class="table-value status-${finalStatus.canDownload ? 'success' : 'error'}">${finalStatus.canDownload ? 'Disponível' : 'Indisponível'}</td>
                            <td class="table-details">${finalStatus.reason}</td>
                        </tr>
                    </tbody>
                </table>
            </div>
            
            <div class="debug-section">
                <h3>Diagnóstico Final</h3>
                <table class="debug-table">
                    <tbody>
                        <tr>
                            <td class="table-label">Cenário identificado</td>
                            <td class="table-value scenario-${scenario.includes('DISPONÍVEIS') ? 'success' : scenario.includes('NÃO PROCESSADA') ? 'warning' : 'error'}">${scenario}</td>
                        </tr>
                        <tr>
                            <td class="table-label">Recomendação</td>
                            <td class="table-details">${getRecommendation(scenario)}</td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>
    `;

    summaryModalContent.value = debugInfo;
    isSummaryModalOpen.value = true;

    // Retorna informações para uso em outros lugares
    return {
        sale,
        info,
        dateCheck,
        cachedResult,
        finalStatus,
        scenario
    };
}


// Função para gerar recomendações baseadas no cenário
function getRecommendation(scenario) {
    switch (scenario) {
        case 'CENÁRIO 1: VENDA NÃO PROCESSADA':
            return 'Processe a venda primeiro usando o botão "Processar Vendas" no painel de ações.';
        case 'CENÁRIO 2: DATA LIMITE NÃO ATINGIDA':
            return 'Aguarde até a data limite de envio ou use o botão "Forçar Verificação" para tentar mesmo assim.';
        case 'CENÁRIO 3: STATUS DA VENDA IMPEDE IMPRESSão':
            return 'Verifique se o status da venda está correto. Se a venda foi cancelada ou já enviada, a etiqueta não estará disponível.';
        case 'CENÁRIO 4: DADOS BÁSICOS INVÁLIDOS':
            return 'Sincronize a venda novamente para obter os dados completos do Mercado Livre.';
        case 'CENÁRIO 5: ETIQUETAS NÃO VERIFICADAS':
            return 'Use o botão "Verificar" para checar a disponibilidade na API do Mercado Livre.';
        case 'CENÁRIO 6: ETIQUETAS DISPONÍVEIS':
            return 'A etiqueta está pronta para download. Use os botões PDF ou ZPL para baixar.';
        case 'CENÁRIO 7: ERROS DE API':
            return 'Verifique a conexão com a internet e tente novamente. Se o problema persistir, use "Forçar Verificação".';
        case 'CENÁRIO 8: PROBLEMAS DE TIMEZONE':
            return 'Use o botão "Forçar Verificação" para ignorar o cache e verificar novamente.';
        case 'CENÁRIO 9: STATUS DESCONHECIDOS':
            return 'O sistema tentará verificar na API. Use o botão "Verificar" para confirmar a disponibilidade.';
        case 'CENÁRIO 10: CACHE DESATUALIZADO':
            return 'Use o botão "Forçar Verificação" para limpar o cache e verificar novamente.';
        default:
            return 'Use o botão "Verificar" para tentar obter a etiqueta ou "Forçar Verificação" para limpar o cache.';
    }
}







// Opções de Status da Venda (API) e mapeador de rótulos
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

// Opções de Tipos de Expedição
const shippingTypeOptions = computed(() => {
    const set = new Set();
    (sales.value || []).forEach(s => {
        const v = s?.shipping_mode || null;
        if (v) set.add(String(v));
    });
    return Array.from(set)
        .map(value => ({ value, label: getShippingTypeLabel(value) }))
        .sort((a, b) => a.label.localeCompare(b.label));
});

function getSaleStatusLabel(statusValue) {
    if (!statusValue) return 'Pendente';
    const map = {
        paid: 'Pago',
        ready_to_ship: 'Pronto para Envio',
        shipped: 'Enviado',
        delivered: 'Entregue',
        cancelled: 'Cancelado',
        canceled: 'Cancelado',
    };
    const key = String(statusValue).toLowerCase();
    return map[key] || (key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' '));
}

function getShippingTypeLabel(typeValue) {
    if (!typeValue) return 'N/A';
    const map = {
        'me1': 'Mercado Envios',
        'me2': 'Mercado Envios 2',
        'not_specified': 'Não Especificado',
        'custom': 'Personalizado',
        'drop_off': 'Retirada',
        'pick_up': 'Entrega',
        'fulfillment': 'Fulfillment',
        'marketplace': 'Marketplace',
        'logistics': 'Logística',
    };
    const key = String(typeValue).toLowerCase();
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
    if (valueLower.includes('paid')) return 'status-badge-blue';
    if (valueLower.includes('shipped')) return 'status-badge-purple';
    if (valueLower.includes('delivered')) return 'status-badge-green';
    if (valueLower.includes('cancelled')) return 'status-badge-gray';
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
function toggleAccountDropdown() { isAccountDropdownOpen.value = !isAccountDropdownOpen.value; }
function applyAccountFilter(id) { selectedAccountFilterId.value = id ?? null; isAccountDropdownOpen.value = false; }

function setSaleDatePeriod(period) {
    const base = new Date();
    base.setHours(0, 0, 0, 0);
    const today = new Date(base);
    const yesterday = new Date(base); yesterday.setDate(base.getDate() - 1);
    const tomorrow = new Date(base); tomorrow.setDate(base.getDate() + 1);

    if (period === 'today') {
        filters.saleDateStart = toLocalDateInputValue(today);
        filters.saleDateEnd = toLocalDateInputValue(today);
    } else if (period === 'yesterday') {
        filters.saleDateStart = toLocalDateInputValue(yesterday);
        filters.saleDateEnd = toLocalDateInputValue(yesterday);
    } else if (period === 'tomorrow') {
        filters.saleDateStart = toLocalDateInputValue(tomorrow);
        filters.saleDateEnd = toLocalDateInputValue(tomorrow);
    }
}

function setShippingLimitPeriod(period) {
    const base = new Date();
    base.setHours(0, 0, 0, 0);
    const today = new Date(base);
    const yesterday = new Date(base); yesterday.setDate(base.getDate() - 1);
    const tomorrow = new Date(base); tomorrow.setDate(base.getDate() + 1);

    if (period === 'today') {
        filters.shippingLimitStart = toLocalDateInputValue(today);
        filters.shippingLimitEnd = toLocalDateInputValue(today);
    } else if (period === 'yesterday') {
        filters.shippingLimitStart = toLocalDateInputValue(yesterday);
        filters.shippingLimitEnd = toLocalDateInputValue(yesterday);
    } else if (period === 'tomorrow') {
        filters.shippingLimitStart = toLocalDateInputValue(tomorrow);
        filters.shippingLimitEnd = toLocalDateInputValue(tomorrow);
    }
}

function clearFilters() {
    filters.accountId = null;
    filters.saleDateStart = '';
    filters.saleDateEnd = '';
    filters.shippingLimitStart = '';
    filters.shippingLimitEnd = '';
    filters.saleStatus = null;
    filters.shippingType = null;
    filters.shippingStatus = null;
    searchQuery.value = '';
    selectedStatusFilter.value = null;
    selectedAccountFilterId.value = null;
    salesCurrentPage.value = 1;
}

async function handleSaleStatusChange(sale, newStatus) {
    try {
        await updateSaleStatus(sale, newStatus);
    } catch (err) {
        console.error('Falha ao atualizar status.', err);
        summaryModalTitle.value = 'Erro ao Atualizar';
        summaryModalContent.value = `<p>Ocorreu um erro:</p><p class="error-text">${err.message}</p>`;
        isSummaryModalOpen.value = true;
        await fetchSales();
    }
}

function openStatusModal(sale) { selectedSaleForStatusChange.value = sale; isStatusModalOpen.value = true; }
function closeStatusModal() { isStatusModalOpen.value = false; setTimeout(() => { selectedSaleForStatusChange.value = null; }, 300); }

function resolveStatusForBackend(statusValue) {
    if (!statusValue) return statusValue;
    const val = String(statusValue).trim();
    // Padroniza 'Despachado' para o backend, sem mapeamento custom
    if (/^despachado$/i.test(val)) return 'Despachado';
    return val;
}

async function selectNewStatus(newStatus) {
    if (!selectedSaleForStatusChange.value) return;
    const resolved = resolveStatusForBackend(newStatus);
    await handleSaleStatusChange(selectedSaleForStatusChange.value, resolved);
    closeStatusModal();
}

async function processAllSales() {
    isProcessing.value = true;
    try {
        await loadStorageData();
        const base = paginatedUserSales.value;
        const salesToProcess = base.filter(sale => {
            const saleSku = normalizeSku(sale.sku);
            const gerenciarSkuSim = saleSku && stockSkuSet.value.has(saleSku);
            return !sale.processed_at && gerenciarSkuSim;
        });

        if (salesToProcess.length === 0) {
            summaryModalTitle.value = 'Nenhuma Venda para Processar';
            summaryModalContent.value = '<p>Não foi encontrada nenhuma venda pendente com SKU correspondente no estoque nos filtros atuais.</p>';
            isSummaryModalOpen.value = true;
            return;
        }

        const results = await processSalesApi(salesToProcess);
        summaryModalTitle.value = 'Resumo do Processamento';
        let contentHtml = '<p>O processamento em lote foi concluído.</p>';
        if (results.success?.length > 0) {
            contentHtml += `<div class="summary-section success"><h4>✅ ${results.success.length} Vendas Processadas com Sucesso</h4><ul>`;
            results.success.forEach(s => { contentHtml += `<li>Venda #${s.saleId} (SKU: ${s.sku})</li>`; });
            contentHtml += `</ul></div>`;
        }
        if (results.failed?.length > 0) {
            contentHtml += `<div class="summary-section failed"><h4>❌ ${results.failed.length} Vendas Falharam</h4><ul>`;
            results.failed.forEach(f => { contentHtml += `<li>Venda #${f.saleId} (SKU: ${f.sku}): <strong>${f.reason}</strong></li>`; });
            contentHtml += `</ul></div>`;
        }
        summaryModalContent.value = contentHtml;
        isSummaryModalOpen.value = true;

    } catch (err) {
        console.error("Erro ao processar vendas em lote:", err);
        summaryModalTitle.value = 'Erro no Processamento';
        summaryModalContent.value = `<p>Ocorreu um erro inesperado:</p><p class="error-text">${err.message}</p>`;
        isSummaryModalOpen.value = true;
    } finally {
        await fetchSales();
        isProcessing.value = false;
    }
}

async function processSelectedSales() {
    if (selectedSaleKeys.value.size === 0) return;
    isProcessing.value = true;
    try {
        await loadStorageData();
        const selectedSet = new Set(selectedSaleKeys.value);
        const candidates = sales.value.filter((s) => selectedSet.has(saleKey(s)));
        const salesToProcess = candidates.filter(isSaleSelectable);

        if (salesToProcess.length === 0) {
            summaryModalTitle.value = 'Nenhuma Seleção Válida';
            summaryModalContent.value = '<p>As vendas selecionadas não são elegíveis para processamento (já processadas ou SKU não gerenciado).</p>';
            isSummaryModalOpen.value = true;
            return;
        }

        const results = await processSalesApi(salesToProcess);
        summaryModalTitle.value = 'Resumo do Processamento (Selecionadas)';
        let contentHtml = '<p>O processamento das vendas selecionadas foi concluído.</p>';
        if (results.success?.length > 0) {
            contentHtml += `<div class="summary-section success"><h4>${results.success.length} venda(s) processada(s) com sucesso</h4><ul>`;
            results.success.forEach(s => { contentHtml += `<li>Venda #${s.saleId} (SKU: ${s.sku})</li>`; });
            contentHtml += `</ul></div>`;
        }
        if (results.failed?.length > 0) {
            contentHtml += `<div class="summary-section failed"><h4>${results.failed.length} venda(s) falharam</h4><ul>`;
            results.failed.forEach(f => { contentHtml += `<li>Venda #${f.saleId} (SKU: ${f.sku}): <strong>${f.reason}</strong></li>`; });
            contentHtml += `</ul></div>`;
        }
        summaryModalContent.value = contentHtml;
        isSummaryModalOpen.value = true;

        // Limpa seleções processadas com sucesso
        if (results.success?.length) {
            const processedKeys = new Set(results.success.map(s => `${s.saleId}-${s.sku}`));
            const next = new Set(selectedSaleKeys.value);
            processedKeys.forEach(k => next.delete(k));
            selectedSaleKeys.value = next;
        }
    } catch (err) {
        console.error('Erro ao processar selecionadas em massa:', err);
        summaryModalTitle.value = 'Erro no Processamento';
        summaryModalContent.value = `<p>Ocorreu um erro inesperado:</p><p class="error-text">${err.message}</p>`;
        isSummaryModalOpen.value = true;
    } finally {
        await fetchSales();
        isProcessing.value = false;
    }
}
const handleUnifiedSync = async () => {
    await handleSync();
};

async function applyBulkStatus(newStatus) {
    try {
        isBulkStatusModalOpen.value = false;
        const resolved = resolveStatusForBackend(newStatus);
        const targets = selectedSales.value;
        if (!targets.length) {
            summaryModalTitle.value = 'Nenhuma venda selecionada';
            summaryModalContent.value = '<p>Selecione ao menos uma venda para alterar o status.</p>';
            isSummaryModalOpen.value = true;
            return;
        }

        const results = await Promise.allSettled(
            targets.map((sale) => updateSaleStatus(sale, resolved))
        );

        let ok = 0; let fail = 0; const errors = [];
        results.forEach((r, idx) => {
            if (r.status === 'fulfilled') ok++;
            else { fail++; errors.push({ sale: targets[idx], reason: r.reason?.message || 'Erro desconhecido' }); }
        });

        summaryModalTitle.value = 'Resumo da Alteração de Status (Em massa)';
        let html = `<p>Atualização concluída: <strong>${ok}</strong> sucesso, <strong>${fail}</strong> falha(s).</p>`;
        if (fail > 0) {
            html += '<div class="summary-section failed"><h4>Falhas</h4><ul>';
            errors.slice(0, 30).forEach(e => {
                html += `<li>Venda #${e.sale.id} (SKU: ${e.sale.sku}): <strong>${e.reason}</strong></li>`;
            });
            if (errors.length > 30) html += `<li>... e mais ${errors.length - 30}</li>`;
            html += '</ul></div>';
        }
        summaryModalContent.value = html;
        isSummaryModalOpen.value = true;

    } catch (err) {
        summaryModalTitle.value = 'Erro na Alteração em Massa';
        summaryModalContent.value = `<p>Ocorreu um erro:</p><p class="error-text">${err.message}</p>`;
        isSummaryModalOpen.value = true;
    } finally {
        await fetchSales();
    }
}

// Sistema de verificação automática em tempo real
function startAutoCheck() {
    if (autoCheckInterval.value) return;

    autoCheckStatus.value = 'Ativo';
    autoCheckInterval.value = setInterval(async () => {
        if (!isAutoCheckEnabled.value) return;

        try {
            autoCheckStatus.value = 'Verificando...';
            lastAutoCheck.value = new Date();
            autoCheckCount.value++;

            // Verifica apenas vendas que podem ter etiquetas disponíveis
            const salesToCheck = paginatedUserSales.value.filter(sale => {
                const info = getLabelInfo(sale);
                const dateCheck = isLabelAvailableByDate(sale);
                return info.canPrint && info.shipmentId && info.sellerId && dateCheck.available;
            });

            if (salesToCheck.length > 0) {
                await performAutoCheck(salesToCheck);
            }

            autoCheckStatus.value = 'Aguardando próxima verificação...';
        } catch (error) {
            console.error('Erro na verificação automática:', error);
            autoCheckStatus.value = 'Erro na verificação';
        }
    }, 30000); // Verifica a cada 30 segundos
}

function stopAutoCheck() {
    if (autoCheckInterval.value) {
        clearInterval(autoCheckInterval.value);
        autoCheckInterval.value = null;
    }
    autoCheckStatus.value = 'Parado';
}

async function performAutoCheck(salesToCheck) {
    // Agrupa por seller_id para fazer verificações em lote
    const salesBySeller = new Map();
    salesToCheck.forEach(sale => {
        const info = getLabelInfo(sale);
        if (!salesBySeller.has(info.sellerId)) {
            salesBySeller.set(info.sellerId, []);
        }
        salesBySeller.set(info.sellerId, [...salesBySeller.get(info.sellerId), sale]);
    });

    // Verifica cada grupo de vendas
    for (const [sellerId, sales] of salesBySeller) {
        try {
            const shipmentIds = sales.map(sale => getLabelInfo(sale).shipmentId);

            const response = await fetch('/api/mercadolivre/check-labels-availability', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    seller_id: sellerId,
                    shipment_ids: shipmentIds
                })
            });

            if (response.ok) {
                const results = await response.json();

                // Atualiza o cache com os resultados
                Object.entries(results).forEach(([shipmentId, result]) => {
                    const cacheKey = `${shipmentId}-${sellerId}`;
                    if (result.available) {
                        labelAvailabilityCache.value.set(cacheKey, { available: true });
                    } else {
                        labelAvailabilityCache.value.set(cacheKey, {
                            available: false,
                            reason: result.error || 'Etiqueta não disponível'
                        });
                    }
                });
            }
        } catch (error) {
            console.error('Erro ao verificar etiquetas para seller:', sellerId, error);
        }
    }
}

function toggleAutoCheck() {
    isAutoCheckEnabled.value = !isAutoCheckEnabled.value;
    if (isAutoCheckEnabled.value) {
        startAutoCheck();
    } else {
        stopAutoCheck();
    }
}

// Função para verificar disponibilidade de todas as etiquetas
async function checkAllLabelsAvailability() {
    if (isCheckingLabels.value) return;

    isCheckingLabels.value = true;

    try {
        // Coleta todas as vendas que podem ter etiquetas e estão disponíveis por data
        const salesWithLabels = paginatedUserSales.value.filter(sale => {
            const info = getLabelInfo(sale);
            const dateCheck = isLabelAvailableByDate(sale);
            return info.canPrint && info.shipmentId && info.sellerId && dateCheck.available;
        });

        if (salesWithLabels.length === 0) {
            // Conta quantas vendas não estão disponíveis por data
            const salesNotAvailableByDate = paginatedUserSales.value.filter(sale => {
                const info = getLabelInfo(sale);
                const dateCheck = isLabelAvailableByDate(sale);
                return info.canPrint && info.shipmentId && info.sellerId && !dateCheck.available;
            });

            summaryModalTitle.value = 'Nenhuma Etiqueta para Verificar';
            let message = '<p>Não foram encontradas vendas com etiquetas disponíveis para verificação.</p>';

            if (salesNotAvailableByDate.length > 0) {
                message += `<p><strong>${salesNotAvailableByDate.length}</strong> etiqueta${salesNotAvailableByDate.length > 1 ? 's' : ''} ainda não está${salesNotAvailableByDate.length > 1 ? 'ão' : ''} disponível${salesNotAvailableByDate.length > 1 ? 'eis' : ''} por data limite de envio.</p>`;
                message += '<p class="summary-note">As etiquetas ficam disponíveis apenas no dia do despacho (data limite de envio).</p>';
            }

            summaryModalContent.value = message;
            isSummaryModalOpen.value = true;
            return;
        }

        // Agrupa por seller_id para fazer verificações em lote
        const salesBySeller = new Map();
        salesWithLabels.forEach(sale => {
            const info = getLabelInfo(sale);
            if (!salesBySeller.has(info.sellerId)) {
                salesBySeller.set(info.sellerId, []);
            }
            salesBySeller.get(info.sellerId).push(info.shipmentId);
        });

        let totalChecked = 0;
        let availableCount = 0;
        let unavailableCount = 0;

        // Verifica cada grupo de seller
        for (const [sellerId, shipmentIds] of salesBySeller.entries()) {
            try {
                // Usa o endpoint de verificação múltipla do backend
                const response = await fetch('/api/ml/check-multiple-shipments', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${localStorage.getItem('token')}`
                    },
                    body: JSON.stringify({
                        shipments: shipmentIds,
                        seller_id: sellerId
                    })
                });

                if (response.ok) {
                    const results = await response.json();

                    // Atualiza o cache com os resultados
                    Object.entries(results).forEach(([shipmentId, result]) => {
                        const cacheKey = `${shipmentId}-${sellerId}`;
                        if (result.available) {
                            labelAvailabilityCache.value.set(cacheKey, { available: true });
                            availableCount++;
                        } else {
                            labelAvailabilityCache.value.set(cacheKey, {
                                available: false,
                                reason: result.error || 'Etiqueta não disponível'
                            });
                            unavailableCount++;
                        }
                        totalChecked++;
                    });
                } else {
                    console.error('Erro ao verificar etiquetas para seller:', sellerId);
                }
            } catch (error) {
                console.error('Erro ao verificar etiquetas para seller:', sellerId, error);
            }
        }

        // Mostra o resumo
        summaryModalTitle.value = 'Verificação de Etiquetas Concluída';
        summaryModalContent.value = `
            <div class="verification-summary">
                <p><strong>Verificação concluída!</strong></p>
                <div class="summary-stats">
                    <div class="stat-item available">
                        <span class="stat-number">${availableCount}</span>
                        <span class="stat-label">Etiquetas Disponíveis</span>
                    </div>
                    <div class="stat-item unavailable">
                        <span class="stat-number">${unavailableCount}</span>
                        <span class="stat-label">Etiquetas Indisponíveis</span>
                    </div>
                    <div class="stat-item total">
                        <span class="stat-number">${totalChecked}</span>
                        <span class="stat-label">Total Verificadas</span>
                    </div>
                </div>
                <p class="summary-note">Os indicadores visuais foram atualizados com base na verificação em tempo real.</p>
            </div>
        `;
        isSummaryModalOpen.value = true;

    } catch (error) {
        console.error('Erro ao verificar etiquetas:', error);
        summaryModalTitle.value = 'Erro na Verificação';
        summaryModalContent.value = `<p>Ocorreu um erro ao verificar as etiquetas:</p><p class="error-text">${error.message}</p>`;
        isSummaryModalOpen.value = true;
    } finally {
        isCheckingLabels.value = false;
    }
}

// Função para verificar disponibilidade de uma etiqueta individual
async function checkSingleLabelAvailability(sale) {
    if (isCheckingSingleLabel.value) return;

    isCheckingSingleLabel.value = true;

    try {
        const result = await checkLabelAvailabilityRealTime(sale);

        // Mostra feedback visual temporário
        const info = getLabelInfo(sale);

        if (result.status === 'available') {
            // Feedback positivo
            console.log('✅ Etiqueta disponível:', info.shipmentId);
        } else if (result.status === 'unavailable') {
            // Feedback negativo
            console.log('❌ Etiqueta indisponível:', info.shipmentId, result.reason);
        }

        // Força re-render para atualizar os indicadores visuais
        await nextTick();

    } catch (error) {
        console.error('Erro ao verificar etiqueta individual:', error);
    } finally {
        isCheckingSingleLabel.value = false;
    }
}

const handleSync = async () => {
    if (syncState.value.isSyncing) return;

    if (!mlAccounts.value || mlAccounts.value.length === 0) {
        summaryModalTitle.value = 'Nenhuma Conta Encontrada';
        summaryModalContent.value = '<p>Este usuário não possui contas do Mercado Livre conectadas para sincronizar.</p>';
        isSummaryModalOpen.value = true;
        return;
    }

    const accountToSync = mlAccounts.value[0];
    const { user_id: accountId, nickname } = accountToSync;

    if (!accountId || !nickname) {
        summaryModalTitle.value = 'Dados da Conta Incompletos';
        summaryModalContent.value = '<p>A conta do usuário não possui informações suficientes (ID e Nickname) para sincronizar.</p>';
        isSummaryModalOpen.value = true;
        return;
    }

    try {
        // Primeiro faz a sincronização normal
        await syncAccount(accountId, nickname, props.userId);

        // Aguarda um pouco para a sincronização terminar
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Depois enriquece os dados das vendas existentes
        console.log(`[ENRICH] Chamando enrichExistingSales com accountId: ${accountId}, nickname: ${nickname}, clientUid: ${props.userId}`);
        await enrichExistingSales(accountId, nickname, props.userId);

        // Atualiza as vendas após o enriquecimento
        await fetchSales();

    } catch (error) {
        summaryModalTitle.value = 'Falha na Sincronização/Enriquecimento';
        summaryModalContent.value = `<p>Ocorreu um erro:</p><p class="error-text">${error.message}</p>`;
        isSummaryModalOpen.value = true;
    }
};



function handleClickOutside(event) {
    const target = event.target;
    if (saleStatusFilterContainerRef.value && !saleStatusFilterContainerRef.value.contains(target)) {
        isSaleStatusDropdownOpen.value = false;
    }
    if (statusFilterContainerRef.value && !statusFilterContainerRef.value.contains(target)) {
        isStatusDropdownOpen.value = false;
    }
    if (accountFilterContainerRef.value && !accountFilterContainerRef.value.contains(target)) {
        isAccountDropdownOpen.value = false;
    }
}

function showTooltip(event, text) {
    const el = event.target;
    if (!el || !text || el.scrollWidth <= el.clientWidth) return;

    clearTimeout(hideTooltipTimeout);
    const tooltip = tooltipRef.value;
    if (!tooltip) return;

    const contentSpan = tooltip.querySelector('.tooltip-content');
    if (!contentSpan) return;

    contentSpan.textContent = text;

    const rect = el.getBoundingClientRect();
    const tooltipWidth = tooltip.offsetWidth;
    const tooltipHeight = tooltip.offsetHeight;

    let left = rect.left + (rect.width / 2) - (tooltipWidth / 2);
    let top = rect.bottom + 8;

    if (left < 10) left = 10;
    if (left + tooltipWidth > window.innerWidth - 10) {
        left = window.innerWidth - tooltipWidth - 10;
    }

    let arrowClass = '';
    if (top + tooltipHeight > window.innerHeight - 10) {
        top = rect.top - tooltipHeight - 8;
        arrowClass = 'top';
    }

    tooltip.style.left = `${left + window.pageXOffset}px`;
    tooltip.style.top = `${top + window.pageYOffset}px`;

    const arrow = tooltip.querySelector('.tooltip-arrow');
    if (arrow) {
        arrow.className = `tooltip-arrow ${arrowClass}`;
    }

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

onMounted(() => {
    document.addEventListener('click', handleClickOutside);
    // Inicia a verificação automática quando o componente é montado
    startAutoCheck();
});

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
 * Extrai o nickname do buyer dos dados da API do Mercado Livre
 * @param {Object} sale - Objeto da venda contendo raw_api_data
 * @returns {string} Nickname do buyer ou 'N/A' se não disponível
 */
function getBuyerNickname(sale) {
    try {
        const buyer = sale?.raw_api_data?.buyer;
        if (!buyer) return 'N/A';

        // Retorna especificamente o nickname do buyer
        if (buyer.nickname) {
            return buyer.nickname.trim();
        }
        return 'N/A';
    } catch (error) {
        console.warn('Erro ao extrair nickname do buyer:', error);
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
            document.body.appendChild(textArea);
            textArea.select();
            document.execCommand('copy');
            document.body.removeChild(textArea);
            showToast('ID copiado para a área de transferência', 'success');
        }
    } catch (error) {
        console.error('Erro ao copiar ID da venda:', error);
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

onUnmounted(() => {
    document.removeEventListener('click', handleClickOutside);
    // Para a verificação automática quando o componente é desmontado
    stopAutoCheck();
});
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
    box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
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

.filters-left-group,
.filters-right-group {
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
    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -2px rgba(0, 0, 0, 0.1);
    overflow: hidden;
    animation: fadeIn 0.1s ease-out;
}

@keyframes fadeIn {
    from {
        opacity: 0;
        transform: translateY(-5px);
    }

    to {
        opacity: 1;
        transform: translateY(0);
    }
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

.period-buttons {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.5rem;
}

.period-buttons button {
    font-size: 0.75rem;
    padding: 0.25rem 0.5rem;
    border: 1px solid #d1d5db;
    background: #f9fafb;
    border-radius: 0.375rem;
    cursor: pointer;
    color: #374151;
}

.period-buttons button:hover {
    background-color: #f3f4f6;
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

.table-actions-left,
.table-actions-right {
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

.btn-success {
    background-color: #22c55e;
    color: #fff;
}

.btn-success:hover:not(:disabled) {
    background-color: #16a34a;
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
    flex: 1;
    min-height: 0;
}

.sales-table-container {
    background-color: #fff;
    border-radius: 0.75rem;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
}

.table-wrapper {
    overflow-x: auto;
    overflow-y: auto;
    flex: 1;
}

.sales-table {
    width: 100%;
    min-width: 1200px;
    border-collapse: collapse;
}

.sales-table th,
.sales-table td {
    white-space: nowrap;
    padding: 1rem 1.25rem;
    border-bottom: 1px solid #e5e7eb;
    text-overflow: ellipsis;
    overflow: hidden;
}

.sales-table th {
    font-weight: 600;
    color: #4b5563;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    background-color: #f9fafb;
}

.sales-table tbody tr:hover {
    background-color: #f3f4f6;
}

.product-title,
.sku-cell {
    max-width: 250px;
    cursor: pointer;
}

.buyer-nickname-cell {
    max-width: 150px;
    cursor: pointer;
}

.channel-badge.ml {
    background-color: #ffe600;
    color: #333;
    display: inline-block;
    padding: 0.25rem 0.6rem;
    font-size: 0.75rem;
    font-weight: 500;
    border-radius: 9999px;
}

.status-badge {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
}

.status-badge-default {
    background-color: #d1d5db;
}

.status-badge-blue {
    background-color: #3b82f6;
}

.status-badge-yellow {
    background-color: #f59e0b;
}

.status-badge-purple {
    background-color: #8b5cf6;
}

.status-badge-green {
    background-color: #22c55e;
}

.status-badge-gray {
    background-color: #6b7280;
}

.status-badge-cyan {
    background-color: #06b6d4;
}

.status-badge-indigo {
    background-color: #6366f1;
}

.status-badge-red {
    background-color: #ef4444;
}

.status-badge-orange {
    background-color: #f97316;
}

.pagination-controls {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1rem 1.25rem;
    border-top: 1px solid #e5e7eb;
}

.pagination-controls button {
    padding: 0.5rem 1rem;
    border: 1px solid #d1d5db;
    border-radius: 0.375rem;
    background-color: #fff;
    font-weight: 500;
    cursor: pointer;
}

.pagination-controls button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.loading-state,
.error-state,
.empty-state {
    text-align: center;
    padding: 4rem 2rem;
    color: #6b7280;
}

.custom-tooltip {
    position: fixed;
    background-color: #1f2937;
    color: #fff;
    padding: 0.6rem 0.8rem;
    border-radius: 0.5rem;
    font-size: 0.8rem;
    z-index: 1000;
    pointer-events: none;
    visibility: hidden;
    opacity: 0;
}

.tooltip-arrow {
    position: absolute;
    bottom: 100%;
    left: 50%;
    transform: translateX(-50%);
    width: 0;
    height: 0;
    border-left: 6px solid transparent;
    border-right: 6px solid transparent;
    border-bottom: 6px solid #1f2937;
}

.tag {
    padding: 0.2rem 0.6rem;
    border-radius: 9999px;
    font-size: 0.75rem;
    font-weight: 600;
}

.tag.processed {
    background-color: #dcfce7;
    color: #166534;
}

.tag.unprocessed {
    background-color: #fee2e2;
    color: #991b1b;
}

.modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.75rem;
    margin-top: 1.5rem;
}

.status-select-trigger {
    display: flex;
    justify-content: space-between;
    align-items: center;
    width: 100%;
    padding: 0.5rem 0.75rem;
    border-radius: 0.375rem;
    border: 1px solid #d1d5db;
    background-color: #fff;
    cursor: pointer;
    text-align: left;
    transition: all 0.2s;
    min-width: 190px;
}

.status-select-trigger:hover {
    border-color: #4f46e5;
    box-shadow: 0 0 0 1px #4f46e5;
}

.status-cell {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    overflow: hidden;
    flex-grow: 1;
    min-width: 0;
}

.status-cell span:last-child {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.status-arrow {
    color: #9ca3af;
    flex-shrink: 0;
}

.status-modal-content {
    display: flex;
    flex-direction: column;
    gap: 1rem;
}

.status-selection-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
}

.status-selection-list li {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.85rem 1rem;
    border-radius: 0.5rem;
    border: 1px solid #e5e7eb;
    cursor: pointer;
    transition: all 0.2s;
}

.status-selection-list li:hover {
    background-color: #f9fafb;
    border-color: #4f46e5;
}

.animate-spin {
    animation: spin 1s linear infinite;
}

@keyframes spin {
    from {
        transform: rotate(0deg);
    }

    to {
        transform: rotate(360deg);
    }
}

.new-sales-badge {
    position: absolute;
    top: -8px;
    right: -8px;
    background: #ef4444;
    color: white;
    border-radius: 50%;
    min-width: 20px;
    height: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.75rem;
    font-weight: 600;
    border: 2px solid white;
}

.sync-btn {
    position: relative;
}

/* Estilos para o indicador de verificação automática */
.auto-check-status {
    background: linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%);
    border: 1px solid #bae6fd;
    border-radius: 0.5rem;
    padding: 0.75rem 1rem;
    margin-bottom: 1rem;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
}

.status-indicator {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    font-size: 0.875rem;
    color: #0369a1;
}

.status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background-color: #10b981;
    transition: all 0.3s ease;
}

.status-dot.pulsing {
    animation: pulse 1.5s infinite;
    background-color: #3b82f6;
}

@keyframes pulse {

    0%,
    100% {
        opacity: 1;
        transform: scale(1);
    }

    50% {
        opacity: 0.5;
        transform: scale(1.2);
    }
}

.status-text {
    font-weight: 600;
    color: #0369a1;
}

.last-check {
    color: #64748b;
    font-size: 0.8rem;
}

.check-count {
    color: #64748b;
    font-size: 0.8rem;
    background-color: #f1f5f9;
    padding: 0.25rem 0.5rem;
    border-radius: 0.25rem;
}

.cancelled-sale {
    background-color: #fee2e2;
}

.cancelled-sale:hover {
    background-color: #fecaca;
}

/* Estilos para etiquetas */
.label-actions {
    display: flex;
    gap: 0.75rem;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
}

.label-button-group {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    position: relative;
}

.btn-label {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.25rem 0.5rem;
    font-size: 0.75rem;
    font-weight: 500;
    border: 1px solid;
    border-radius: 0.375rem;
    cursor: pointer;
    transition: all 0.2s;
    text-decoration: none;
    min-width: 60px;
    justify-content: center;
}

.btn-label.pdf {
    background-color: #fef2f2;
    border-color: #fecaca;
    color: #dc2626;
}

.btn-label.pdf:hover {
    background-color: #fee2e2;
    border-color: #fca5a5;
    transform: translateY(-1px);
}

.btn-label.zpl {
    background-color: #f0f9ff;
    border-color: #bae6fd;
    color: #0284c7;
}

.btn-label.zpl:hover {
    background-color: #e0f2fe;
    border-color: #7dd3fc;
    transform: translateY(-1px);
}

.btn-label.check {
    background-color: #f0fdf4;
    border-color: #bbf7d0;
    color: #16a34a;
}

.btn-label.check:hover:not(:disabled) {
    background-color: #dcfce7;
    border-color: #86efac;
    transform: translateY(-1px);
}

.btn-label.check:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    transform: none;
}

.btn-label.debug {
    background-color: #fef3c7;
    border-color: #fde68a;
    color: #d97706;
}

.btn-label.debug:hover {
    background-color: #fde68a;
    border-color: #fcd34d;
    transform: translateY(-1px);
}

.btn-label svg {
    width: 12px;
    height: 12px;
    flex-shrink: 0;
}

/* Estilos para botões desabilitados */
.btn-label-disabled {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.25rem 0.5rem;
    font-size: 0.75rem;
    font-weight: 500;
    border: 1px solid;
    border-radius: 0.375rem;
    min-width: 60px;
    justify-content: center;
    opacity: 0.5;
    cursor: not-allowed;
    position: relative;
}

.btn-label-disabled.pdf {
    background-color: #f9fafb;
    border-color: #e5e7eb;
    color: #9ca3af;
}

.btn-label-disabled.zpl {
    background-color: #f9fafb;
    border-color: #e5e7eb;
    color: #9ca3af;
}

/* Estilos específicos para botões desabilitados por data expirada */
.btn-label-disabled[title*="expirou"] {
    background-color: #fef2f2;
    border-color: #fecaca;
    color: #dc2626;
    opacity: 0.8;
}

.btn-label-disabled[title*="expirou"]::after {
    content: "⏰";
    position: absolute;
    top: -2px;
    right: -2px;
    font-size: 0.6rem;
    background-color: #dc2626;
    color: white;
    border-radius: 50%;
    width: 12px;
    height: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
}

.btn-label-disabled svg {
    width: 12px;
    height: 12px;
    flex-shrink: 0;
}

/* Indicadores visuais */
.label-indicator {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    position: relative;
}

.label-indicator.available {
    background-color: #dcfce7;
    border: 1px solid #22c55e;
}

.label-indicator.unavailable {
    background-color: #fee2e2;
    border: 1px solid #ef4444;
}

.label-indicator.unknown {
    background-color: #fef3c7;
    border: 1px solid #f59e0b;
}

.label-indicator.date-unavailable {
    background-color: #fef2f2;
    border: 1px solid #ef4444;
    position: relative;
}

.label-indicator.date-unavailable::before {
    content: "📅";
    position: absolute;
    top: -2px;
    right: -2px;
    font-size: 8px;
    background: white;
    border-radius: 50%;
    width: 12px;
    height: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
}

.indicator-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    display: block;
}

.label-indicator.available .indicator-dot {
    background-color: #22c55e;
}

.label-indicator.unavailable .indicator-dot {
    background-color: #ef4444;
}

.label-indicator.date-unavailable .indicator-dot {
    background-color: #ef4444;
}

.label-indicator.unknown .indicator-dot {
    background-color: #f59e0b;
}

/* Tooltip para indicadores */
.label-indicator::after {
    content: attr(data-tooltip);
    position: absolute;
    bottom: 100%;
    left: 50%;
    transform: translateX(-50%);
    background-color: #1f2937;
    color: white;
    padding: 0.25rem 0.5rem;
    border-radius: 0.25rem;
    font-size: 0.75rem;
    white-space: nowrap;
    opacity: 0;
    visibility: hidden;
    transition: all 0.2s;
    z-index: 1000;
    margin-bottom: 0.25rem;
}

.label-indicator:hover::after {
    opacity: 1;
    visibility: visible;
}

.label-unavailable {
    color: #9ca3af;
    font-size: 0.875rem;
    font-style: italic;
}

.error-text {
    background-color: #fff5f5;
    color: #c53030;
    padding: 0.75rem;
    border-left: 4px solid #c53030;
    border-radius: 0.25rem;
    font-family: monospace;
    white-space: pre-wrap;
    word-break: break-all;
}

/* Estilos para o resumo de verificação de etiquetas */
.verification-summary {
    text-align: center;
}

.summary-stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: 1rem;
    margin: 1.5rem 0;
}

.stat-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 1rem;
    border-radius: 0.5rem;
    border: 2px solid;
}

.stat-item.available {
    background-color: #f0fdf4;
    border-color: #22c55e;
    color: #166534;
}

.stat-item.unavailable {
    background-color: #fef2f2;
    border-color: #ef4444;
    color: #991b1b;
}

.stat-item.total {
    background-color: #f8fafc;
    border-color: #64748b;
    color: #334155;
}

.stat-number {
    font-size: 2rem;
    font-weight: 700;
    line-height: 1;
}

.stat-label {
    font-size: 0.875rem;
    font-weight: 500;
    margin-top: 0.5rem;
    text-align: center;
}

.summary-note {
    font-size: 0.875rem;
    color: #6b7280;
    margin-top: 1rem;
    font-style: italic;
}

/* Estilos para tabelas dos modais de debug */
.debug-table {
    width: 100%;
    border-collapse: collapse;
    margin: 1rem 0;
    background-color: #fff;
    border-radius: 0.5rem;
    overflow: hidden;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.table-header {
    background-color: #f8fafc;
    color: #374151;
    font-weight: 600;
    font-size: 0.875rem;
    padding: 0.75rem 1rem;
    text-align: left;
    border-bottom: 2px solid #e5e7eb;
}

.table-label {
    background-color: #f8fafc;
    color: #6b7280;
    font-weight: 600;
    font-size: 0.875rem;
    padding: 0.75rem 1rem;
    border-right: 1px solid #e5e7eb;
    width: 30%;
    vertical-align: top;
}

.table-value {
    color: #1f2937;
    font-size: 0.875rem;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid #f3f4f6;
    vertical-align: top;
}

.table-details {
    color: #374151;
    font-size: 0.875rem;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid #f3f4f6;
    vertical-align: top;
    line-height: 1.5;
}

.debug-table tr:hover {
    background-color: #f9fafb;
}
</style>
