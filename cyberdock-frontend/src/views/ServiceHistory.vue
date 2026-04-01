<template>
  <div class="service-history-container">
    <!-- Painel de Filtros Compacto com Dropdown -->
    <div class="filters-container">
      <div class="filters-header">
        <button @click="toggleFilters" class="filter-toggle-btn">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
            class="icon icon-tabler icons-tabler-outline icon-tabler-filter">
            <path stroke="none" d="M0 0h24v24H0z" fill="none" />
            <path
              d="M4 4h16v2.172a2 2 0 0 1 -.586 1.414l-4.414 4.414v7l-6 2v-8.5l-4.48 -4.928a2 2 0 0 1 -.52 -1.345v-2.227z" />
          </svg>
          <span>Filtros Avançados</span>

          <!-- Contador de filtros ativos -->
          <span v-if="activeFiltersCount > 0" class="filter-badge">
            {{ activeFiltersCount }}
          </span>

          <svg class="chevron-icon" :class="{ 'rotate-180': isFiltersOpen }" width="16" height="16" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </button>

      </div>

      <!-- Dropdown de filtros -->
      <transition name="fade-slide">
        <div v-if="isFiltersOpen" class="filters-dropdown">
          <div class="filters-grid">
            <!-- Tipo de serviço -->
            <div class="filter-item">
              <label>Filtrar por Tipo</label>
              <div class="select-wrapper">
                <select v-model="filters.serviceType" @change="applyFilters">
                  <option :value="null">Todos os Serviços</option>
                  <option value="contract">Apenas Contratados</option>
                  <option value="manual">Apenas Avulsos</option>
                </select>
                <svg class="select-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  stroke-width="2">
                  <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
              </div>
            </div>

            <!-- Cliente -->
            <div class="filter-item">
              <label>Conta/Cliente</label>
              <div class="select-wrapper">
                <select v-model="filters.clientId" @change="applyFilters">
                  <option :value="null">Todas as Contas</option>
                  <option v-for="user in users" :key="user.uid" :value="user.uid">
                    {{ user.mlNickname || user.name || user.email }}
                  </option>
                </select>
                <svg class="select-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  stroke-width="2">
                  <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
              </div>
            </div>

            <!-- Serviço Contratado (condicional) -->
            <div class="filter-item" v-if="filters.serviceType === 'contract' || filters.serviceType === null">
              <label>Serviço Contratado</label>
              <div class="select-wrapper">
                <select v-model="filters.serviceId" @change="applyFilters">
                  <option :value="null">Todos os Serviços</option>
                  <option v-for="service in availableServices" :key="service.id" :value="service.id">
                    {{ service.name }}
                  </option>
                </select>
                <svg class="select-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  stroke-width="2">
                  <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
              </div>
            </div>

            <!-- Data Inicial -->
            <div class="filter-item">
              <label>Data Inicial</label>
              <div class="input-icon-wrapper">
                <input type="date" v-model="filters.dateFrom" @change="applyFilters" />
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                  <line x1="16" y1="2" x2="16" y2="6"></line>
                  <line x1="8" y1="2" x2="8" y2="6"></line>
                  <line x1="3" y1="10" x2="21" y2="10"></line>
                </svg>
              </div>
            </div>

            <!-- Data Final -->
            <div class="filter-item">
              <label>Data Final</label>
              <div class="input-icon-wrapper">
                <input type="date" v-model="filters.dateTo" @change="applyFilters" />
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                  <line x1="16" y1="2" x2="16" y2="6"></line>
                  <line x1="8" y1="2" x2="8" y2="6"></line>
                  <line x1="3" y1="10" x2="21" y2="10"></line>
                </svg>
              </div>
            </div>

            <!-- Faixa de Preço -->
            <div class="filter-item">
              <label>Faixa de Preço</label>
              <div class="select-wrapper">
                <select v-model="filters.priceRange" @change="applyFilters">
                  <option :value="null">Todos os Valores</option>
                  <option value="0-50">R$ 0 - R$ 50</option>
                  <option value="50-100">R$ 50 - R$ 100</option>
                  <option value="100-500">R$ 100 - R$ 500</option>
                  <option value="500+">Acima de R$ 500</option>
                </select>
                <svg class="select-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  stroke-width="2">
                  <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
              </div>
            </div>
          </div>

          <!-- Ações do dropdown -->
          <div class="dropdown-actions">
            <button @click="clearFilters" class="btn-text">
<svg  xmlns="http://www.w3.org/2000/svg"  width="24"  height="24"  viewBox="0 0 24 24"  fill="none"  stroke="currentColor"  stroke-width="2"  stroke-linecap="round"  stroke-linejoin="round"  class="icon icon-tabler icons-tabler-outline icon-tabler-clear-all"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M8 6h12" /><path d="M6 12h12" /><path d="M4 18h12" /></svg>
              Limpar Filtros
            </button>
          </div>
        </div>
      </transition>
    </div>

    <!-- Tabela de Histórico Unificado -->
    <div class="services-section">
      <div class="section-header">
        <h2>Histórico de Serviços</h2>
        <span class="section-count">{{ unifiedHistory.length }} registro(s)</span>
      </div>

      <div class="table-container">
        <div v-if="isLoading" class="feedback-state">Carregando histórico...</div>
        <div v-else-if="error" class="feedback-state error-state">{{ error }}</div>
        <div v-else-if="unifiedHistory.length === 0" class="feedback-state empty-state">Nenhum registro encontrado com
          os filtros aplicados.</div>

        <table v-else class="history-table unified-table">
          <thead>
            <tr>
              <th>Tipo</th>
              <th>Cliente</th>
              <th>Serviço/Descrição</th>
              <th>Qtd./Volume</th>
              <th>Preço/Total</th>
              <th>Data</th>
              <th>Ações</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in unifiedHistory" :key="item.uniqueKey">
              <td data-label="Tipo">
                <span :class="['service-type', item.type]">{{ item.typeLabel }}</span>
              </td>
              <td data-label="Cliente">{{ item.clientName }}</td>
              <td data-label="Serviço/Descrição">{{ item.serviceDescription }}</td>
              <td data-label="Qtd./Volume">{{ item.quantity }}</td>
              <td data-label="Preço/Total">{{ item.price }}</td>
              <td data-label="Data">{{ item.date }}</td>
              <td data-label="Ações" class="actions-cell">
                <template v-if="item.type === 'manual'">
                  <button @click="openEditModal(item.originalData)" class="btn-action edit" title="Editar">
                    <svg fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
                      stroke-linejoin="round" width="18" height="18" viewBox="0 0 24 24">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                    </svg>
                  </button>
                  <button @click="openDeleteModal(item.originalData)" class="btn-action delete" title="Excluir">
                    <svg fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
                      stroke-linejoin="round" width="18" height="18" viewBox="0 0 24 24">
                      <polyline points="3 6 5 6 21 6"></polyline>
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2 2v2"></path>
                    </svg>
                  </button>
                </template>
                <template v-else>
                  <span class="no-actions">—</span>
                </template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Modal de Edição -->
    <UniversalModal title="Editar Serviço Avulso" :is-open="isEditModalOpen" @close="closeEditModal">
      <form v-if="editableService" @submit.prevent="handleUpdateService" class="service-form">
        <div class="form-group">
          <label>Descrição</label>
          <input type="text" v-model="editableService.description" required />
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Quantidade</label>
            <input type="number" v-model.number="editableService.quantity" min="0" step="any" required />
          </div>
          <div class="form-group">
            <label>Preço Unitário (R$)</label>
            <input type="number" v-model.number="editableService.unit_price" min="0" step="0.01" required />
          </div>
        </div>
        <div class="form-group">
          <label>Data do Serviço</label>
          <input type="date" v-model="editableService.entry_date" required />
        </div>
      </form>
      <div class="modal-actions">
        <button @click="closeEditModal" type="button" class="btn btn-secondary">Cancelar</button>
        <button @click="handleUpdateService" type="button" class="btn btn-primary">Salvar</button>
      </div>
    </UniversalModal>

    <!-- Modal de Exclusão -->
    <UniversalModal title="Confirmar Exclusão" :is-open="isDeleteModalOpen" @close="closeDeleteModal">
      <div v-if="serviceToDelete">
        <p>
          Tem certeza que deseja excluir o serviço <strong>"{{ serviceToDelete.description }}"</strong>
          para o cliente <strong>{{ serviceToDelete.user_nickname || serviceToDelete.user_email }}</strong>?
        </p>
        <p class="warning-text">Esta ação não pode ser desfeita.</p>
      </div>
      <div class="modal-actions">
        <button @click="closeDeleteModal" class="btn btn-secondary">Cancelar</button>
        <button @click="handleConfirmDelete" class="btn btn-danger">Excluir</button>
      </div>
    </UniversalModal>
  </div>
</template>

<script setup>
import { ref, onMounted, reactive, watch, computed } from 'vue';
import { useServiceHistory } from '@/composables/useServiceHistory';
import { useUsers } from '@/composables/useUsers';
import { useServices } from '@/composables/useServices';
import UniversalModal from '@/components/UniversalModal.vue';

const {
  contractHistory,
  manualHistory,
  isLoading,
  error,
  fetchContractHistory,
  fetchManualHistory,
  updateManualService,
  deleteManualService,
} = useServiceHistory();

const { users, fetchUsers } = useUsers();
const { services: availableServices, fetchServices, formatCurrency } = useServices();

const filters = reactive({
  clientId: null,
  serviceId: null,
  serviceType: null,
  dateFrom: null,
  dateTo: null,
  priceRange: null,
});

const isFiltersOpen = ref(false);
const isEditModalOpen = ref(false);
const isDeleteModalOpen = ref(false);
const editableService = ref(null);
const serviceToDelete = ref(null);

// Calcula o número de filtros ativos
const activeFiltersCount = computed(() => {
  return Object.values(filters).filter(value =>
    value !== null && value !== '' && value !== undefined
  ).length;
});

// Computed property to create unified history view with enhanced filtering
const unifiedHistory = computed(() => {
  let unified = [];

  // Add contract services
  contractHistory.value.forEach(item => {
    unified.push({
      uniqueKey: `contract-${item.contract_id}`,
      type: 'contract',
      typeLabel: 'Contratado',
      clientName: item.user_nickname || item.user_email,
      serviceDescription: item.service_name,
      quantity: item.volume ?? 'N/A',
      price: formatCurrency(item.price || 0),
      date: formatDate(item.start_date),
      sortDate: new Date(item.start_date || 0),
      originalData: item,
      priceValue: item.price || 0
    });
  });

  // Add manual services
  manualHistory.value.forEach(item => {
    const total = (item.quantity || 0) * (item.unit_price || 0);
    unified.push({
      uniqueKey: `manual-${item.id}`,
      type: 'manual',
      typeLabel: 'Avulso',
      clientName: item.user_nickname || item.user_email,
      serviceDescription: item.description,
      quantity: item.quantity,
      price: formatCurrency(total),
      date: formatDate(item.entry_date),
      sortDate: new Date(item.entry_date || 0),
      originalData: item,
      priceValue: total
    });
  });

  // Apply client-side filters
  unified = unified.filter(item => {
    // Service type filter
    if (filters.serviceType && filters.serviceType !== item.type) {
      return false;
    }

    // Date range filter
    if (filters.dateFrom) {
      const fromDate = new Date(filters.dateFrom);
      if (item.sortDate < fromDate) return false;
    }

    if (filters.dateTo) {
      const toDate = new Date(filters.dateTo);
      toDate.setHours(23, 59, 59, 999); // End of day
      if (item.sortDate > toDate) return false;
    }

    // Price range filter
    if (filters.priceRange) {
      const price = item.priceValue;
      switch (filters.priceRange) {
        case '0-50':
          if (price < 0 || price > 50) return false;
          break;
        case '50-100':
          if (price < 50 || price > 100) return false;
          break;
        case '100-500':
          if (price < 100 || price > 500) return false;
          break;
        case '500+':
          if (price < 500) return false;
          break;
      }
    }

    return true;
  });

  // Sort by date (most recent first)
  return unified.sort((a, b) => b.sortDate - a.sortDate);
});

const fetchData = () => {
  error.value = null;
  fetchContractHistory(filters);
  fetchManualHistory(filters);
};

const applyFilters = () => {
  fetchData();
};

const clearFilters = () => {
  filters.clientId = null;
  filters.serviceId = null;
  filters.serviceType = null;
  filters.dateFrom = null;
  filters.dateTo = null;
  filters.priceRange = null;
  fetchData();
};

watch(() => filters.serviceType, () => {
  if (filters.serviceType !== 'contract') {
    filters.serviceId = null;
  }
  applyFilters();
});

const toggleFilters = () => {
  isFiltersOpen.value = !isFiltersOpen.value;
};

const openEditModal = (service) => {
  const rawDate = (service.entry_date || '').toString();
  editableService.value = {
    ...service,
    entry_date: rawDate.includes('T') ? rawDate.split('T')[0] : rawDate,
  };
  isEditModalOpen.value = true;
};

const closeEditModal = () => {
  isEditModalOpen.value = false;
  editableService.value = null;
};

const openDeleteModal = (service) => {
  serviceToDelete.value = service;
  isDeleteModalOpen.value = true;
};

const closeDeleteModal = () => {
  isDeleteModalOpen.value = false;
  serviceToDelete.value = null;
};

const handleUpdateService = async () => {
  if (!editableService.value) return;
  const result = await updateManualService(editableService.value.id, editableService.value);
  if (result.success) {
    closeEditModal();
  } else {
    alert(`Erro ao atualizar: ${result.error}`);
  }
};

const handleConfirmDelete = async () => {
  if (!serviceToDelete.value) return;
  const result = await deleteManualService(serviceToDelete.value.id);
  if (result.success) {
    closeDeleteModal();
  } else {
    alert(`Erro ao excluir: ${result.error}`);
  }
};

const formatDate = (dateString) => {
  if (!dateString) return 'N/A';
  return new Date(dateString).toLocaleDateString('pt-BR', { timeZone: 'UTC' });
};

onMounted(() => {
  fetchData();
  fetchUsers();
  fetchServices();
});
</script>

<style scoped>
.filters-container {
  background-color: #fff;
  border-radius: 0.75rem;
  margin-bottom: 1.5rem;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
  border: 1px solid #e5e7eb;
  overflow: hidden;
}

.filters-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.75rem 1rem;
  background-color: #f9fafb;
  border-bottom: 1px solid #e5e7eb;
}

.filter-toggle-btn {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  background: none;
  border: none;
  padding: 0.5rem 0.75rem;
  border-radius: 0.5rem;
  cursor: pointer;
  font-weight: 600;
  color: #4b5563;
  transition: all 0.2s ease;
  width: 100%;
  text-align: left;
}

.filter-toggle-btn:hover {
  background-color: #f3f4f6;
  color: #1f2937;
}

.filter-toggle-btn svg:first-child {
  width: 18px;
  height: 18px;
  color: #6366f1;
}

.chevron-icon {
  margin-left: auto;
  transition: transform 0.3s ease;
  color: #9ca3af;
}

.rotate-180 {
  transform: rotate(180deg);
}

.filter-badge {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  background-color: #6366f1;
  color: white;
  border-radius: 50%;
  font-size: 0.75rem;
  font-weight: 600;
  margin-left: 0.5rem;
}

.main-actions {
  display: flex;
  gap: 0.5rem;
}

.btn-action {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  border-radius: 0.5rem;
  font-size: 0.875rem;
  font-weight: 500;
  background-color: #f9fafb;
  border: 1px solid #e5e7eb;
  color: #4b5563;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-action:hover {
  background-color: #f3f4f6;
  color: #1f2937;
  border-color: #d1d5db;
}

.btn-primary {
  background-color: #4f46e5;
  color: white;
  border-color: #4f46e5;
}

.btn-primary:hover {
  background-color: #4338ca;
  border-color: #3730a3;
}

/* Dropdown de filtros */
.filters-dropdown {
  padding: 1.5rem;
  background-color: #fcfdff;
  border-top: 1px solid #e5e7eb;
}

.filters-grid {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 1rem;
  margin-bottom: 1.5rem;
  align-items: start;
}

.filter-item {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  min-width: 0;
  /* Permite que os items se contraiam quando necessário */
  margin-bottom: 0.5rem;
}

.filter-item label {
  font-size: 0.875rem;
  font-weight: 600;
  color: #4b5563;
  display: flex;
  align-items: center;
  gap: 0.25rem;
  margin-bottom: 0.5rem;
}

.select-wrapper {
  position: relative;
  width: 100%;
}

.select-wrapper select {
  width: 100%;
  padding: 0.75rem 2.5rem 0.75rem 1rem;
  border-radius: 0.5rem;
  border: 1px solid #d1d5db;
  background-color: #fff;
  font-size: 0.875rem;
  appearance: none;
  cursor: pointer;
  transition: border-color 0.2s, box-shadow 0.2s;
  min-width: 0;
  /* Previne overflow em containers pequenos */
}

.select-wrapper select:focus {
  outline: none;
  border-color: #6366f1;
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
}

.select-icon {
  position: absolute;
  right: 1rem;
  top: 50%;
  transform: translateY(-50%);
  pointer-events: none;
  color: #9ca3af;
}

.input-icon-wrapper {
  position: relative;
}

.input-icon-wrapper input {
  width: 100%;
  padding: 0.75rem 2.5rem 0.75rem 1rem;
  border-radius: 0.5rem;
  border: 1px solid #d1d5db;
  background-color: #fff;
  font-size: 0.875rem;
  transition: border-color 0.2s, box-shadow 0.2s;
  min-width: 0;
  /* Previne overflow em containers pequenos */
}

.input-icon-wrapper input:focus {
  outline: none;
  border-color: #6366f1;
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
}

.input-icon-wrapper svg {
  position: absolute;
  right: 1rem;
  top: 50%;
  transform: translateY(-50%);
  color: #9ca3af;
  pointer-events: none;
}

.dropdown-actions {
  display: flex;
  justify-content: flex-end;
  padding-top: 0.5rem;
  border-top: 1px solid #f3f4f6;
}

.btn-text {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  background: none;
  border: none;
  color: #6366f1;
  font-weight: 500;
  padding: 0.5rem 0.75rem;
  border-radius: 0.5rem;
  cursor: pointer;
  transition: background-color 0.2s;
}

.btn-text:hover {
  background-color: #f0f2ff;
}

/* Animação suave para o dropdown */
.fade-slide-enter-active,
.fade-slide-leave-active {
  transition: all 0.3s ease;
  overflow: hidden;
}

.fade-slide-enter-from {
  max-height: 0;
  opacity: 0;
  padding-top: 0;
  padding-bottom: 0;
  margin-top: 0;
  margin-bottom: 0;
}

.fade-slide-leave-to {
  max-height: 0;
  opacity: 0;
  padding-top: 0;
  padding-bottom: 0;
  margin-top: 0;
  margin-bottom: 0;
}

/* New Service Section Styles */
.services-section {
  margin-bottom: 2rem;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1rem 1.5rem;
  background-color: #f9fafb;
  border-top-left-radius: 0.5rem;
  border-top-right-radius: 0.5rem;
  border-bottom: 1px solid #e5e7eb;
}

.section-header h2 {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 600;
  color: #374151;
}

.section-count {
  font-size: 0.875rem;
  color: #6b7280;
  background-color: #e5e7eb;
  padding: 0.25rem 0.75rem;
  border-radius: 9999px;
}

.service-type {
  padding: 0.25rem 0.75rem;
  border-radius: 9999px;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.service-type.contract {
  background-color: #dbeafe;
  color: #1d4ed8;
}

.service-type.manual {
  background-color: #fef3c7;
  color: #d97706;
}

.unified-table {
  background-color: #fff;
}

.no-actions {
  color: #9ca3af;
  font-size: 1rem;
}

.table-container {
  background-color: #fff;
  border-radius: 0.5rem;
  overflow: hidden;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
}

.services-section .table-container {
  border-top-left-radius: 0;
  border-top-right-radius: 0;
}

.history-table {
  width: 100%;
  border-collapse: collapse;
}

.history-table th,
.history-table td {
  padding: 0.75rem 1rem;
  text-align: left;
  border-bottom: 1px solid #e5e7eb;
}

.history-table th {
  background-color: #f9fafb;
  font-size: 0.75rem;
  color: #6b7280;
  text-transform: uppercase;
}

.feedback-state {
  text-align: center;
  padding: 3rem;
  color: #6b7280;
}

.actions-cell {
  display: flex;
  gap: .75rem;
}

.btn-action {
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  display: flex;
  align-items: center;
}

.btn-action.edit {
  color: #9ca3af;
}

.btn-action.edit:hover {
  color: #6366f1;
}

.btn-action.delete {
  color: #9ca3af;
}

.btn-action.delete:hover {
  color: #ef4444;
}

.service-form {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  padding: 0.5rem;
}

.form-group {
  display: flex;
  flex-direction: column;
}

.form-group label {
  margin-bottom: 0.5rem;
  font-weight: 500;
  font-size: 0.875rem;
  color: #374151;
}

.form-group input {
  padding: 0.6rem 0.8rem;
  border: 1px solid #d1d5db;
  border-radius: 0.5rem;
  font-size: 0.875rem;
}

.form-row {
  display: flex;
  gap: 1rem;
}

.form-row .form-group {
  flex: 1;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
  margin-top: 1.5rem;
}

.warning-text {
  font-size: .9rem;
  color: #71717a;
}

.btn {
  padding: 0.6rem 1.2rem;
  font-size: 0.875rem;
  font-weight: 600;
  border-radius: 0.5rem;
  cursor: pointer;
  border: none;
  transition: background-color .2s;
}

.btn-primary {
  background-color: #4f46e5;
  color: #fff;
}

.btn-primary:hover {
  background-color: #4338ca;
}

.btn-secondary {
  background-color: #e5e7eb;
  color: #374151;
}

.btn-secondary:hover {
  background-color: #d1d5db;
}

.btn-danger {
  background-color: #ef4444;
  color: #fff;
}

.btn-danger:hover {
  background-color: #dc2626;
}

/* Responsividade */
@media (max-width: 1400px) {
  .filters-grid {
    grid-template-columns: repeat(3, 1fr);
    gap: 1rem;
  }

  .filters-dropdown {
    padding: 1.25rem;
  }
}

@media (max-width: 1024px) {
  .filters-grid {
    grid-template-columns: repeat(2, 1fr);
    gap: 1rem;
  }

  .filter-item {
    margin-bottom: 0.75rem;
  }

  .filters-header {
    flex-direction: column;
    align-items: flex-start;
    gap: 0.75rem;
  }

  .main-actions {
    width: 100%;
  }

  .btn-action {
    width: 100%;
    justify-content: center;
  }
}

@media (max-width: 768px) {
  .filters-grid {
    grid-template-columns: 1fr;
    gap: 1rem;
  }

  .filter-item {
    margin-bottom: 1rem;
  }

  .filters-dropdown {
    padding: 1rem;
  }

  .filter-item label {
    font-size: 0.8rem;
    margin-bottom: 0.5rem;
  }

  .select-wrapper select,
  .input-icon-wrapper input {
    padding: 0.625rem 2.5rem 0.625rem 1rem;
    font-size: 0.875rem;
  }
}
</style>