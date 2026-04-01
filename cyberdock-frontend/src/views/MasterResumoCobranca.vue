<template>
  <div class="dashboard-wrapper" :class="{ 'is-modal-view': isModalView }">
    <div class="main-content">
      <div class="dashboard-content" ref="contentArea">

        <div v-if="isLoading" class="skeleton-loader">
          <div class="sk-header"></div>
          <div class="sk-filters">
            <div class="sk-filter-group"></div>
            <div class="sk-action-button"></div>
          </div>
          <div class="sk-grid-5">
            <div class="sk-card" v-for="n in 5" :key="n">
              <div class="sk-card-title"></div>
              <div class="sk-card-value"></div>
              <div class="sk-card-description"></div>
            </div>
          </div>
          <div class="sk-table-header">
            <div class="sk-table-title"></div>
          </div>
          <div class="sk-table">
            <div class="sk-table-head">
              <div class="sk-head-cell" v-for="m in 5" :key="m"></div>
            </div>
            <div class="sk-row" v-for="n in 5" :key="n">
              <div class="sk-cell" v-for="m in 5" :key="m"></div>
            </div>
          </div>
        </div>

        <div v-else-if="error" class="error-state">{{ error }}</div>

        <template v-else>
          <div class="filters-and-actions">
            <div class="filters">
              <div class="filter-group">
                <label for="period-filter">Selecione a Competência:</label>
                <select id="period-filter" v-model="selectedPeriod" @change="handlePeriodChange" class="filter-select">
                  <option v-for="p in availablePeriods" :key="p" :value="p">
                    {{ p }}
                  </option>
                </select>
              </div>
            </div>
            <div class="actions">
              <button @click="openManualServiceModal" class="action-button">
                <i class="fas fa-plus-circle"></i> Lançar Serviço Avulso
              </button>
            </div>
          </div>

          <div v-if="currentInvoice" class="stats-cards-grid-5">
            <div class="stat-card">
              <h3 class="card-title">Valor da Fatura</h3>
              <p class="metric-value">{{ formatCurrency(currentInvoice.totalAmount) }}</p>
              <p class="card-description">Vencimento: {{ currentInvoice.dueDate }}</p>
            </div>
            <div class="stat-card">
              <h3 class="card-title">Status da Fatura</h3>
              <p class="metric-value status-text">
                <span :class="['status-badge', getStatusClass(currentInvoice.status)]">
                  {{ getStatusLabel(currentInvoice.status) }}
                </span>
              </p>
              <p class="card-description" v-if="currentInvoice.paymentDate">Pago em: {{ currentInvoice.paymentDate }}</p>
              <p class="card-description" v-else>Aguardando pagamento.</p>
            </div>
            <div class="stat-card">
              <h3 class="card-title">Armazenamento</h3>
              <p class="metric-value">
                {{ currentInvoice.items.filter(i => i.type === 'storage').reduce((acc, item) => acc + item.quantity, 0) }}
                <span class="metric-unit">item(s)</span>
              </p>
              <p class="card-description">Itens de armazenamento cobrados.</p>
            </div>
            <div class="stat-card">
              <h3 class="card-title">Expedição Comum</h3>
              <p class="metric-value">{{ currentInvoice.items.find(i => i.description === 'Expedição Comum')?.quantity || 0 }}</p>
              <p class="card-description">Unidades expedidas.</p>
            </div>
            <div class="stat-card">
              <h3 class="card-title">Expedição Premium</h3>
              <p class="metric-value">{{ currentInvoice.items.find(i => i.description === 'Expedição Premium')?.quantity || 0 }}</p>
              <p class="card-description">Unidades expedidas.</p>
            </div>
          </div>

          <div v-else class="empty-state-full-page">
            <h3>Nenhuma fatura encontrada para {{ selectedPeriod }}</h3>
            <p>Você pode lançar um serviço avulso para criar uma nova fatura para este período.</p>
          </div>

          <div class="table-container" v-if="invoices.length > 0">
            <h2 class="table-title">Histórico de Faturas</h2>
            <table class="history-table">
              <thead>
                <tr>
                  <th>Competência</th>
                  <th>Valor Total</th>
                  <th>Vencimento</th>
                  <th>Status</th>
                  <th>Ações</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="invoice in invoices" :key="invoice.id">
                  <td class="period-code">{{ invoice.period }}</td>
                  <td>{{ formatCurrency(invoice.totalAmount) }}</td>
                  <td>{{ invoice.dueDate }}</td>
                  <td>
                    <span :class="['status-badge', getStatusClass(invoice.status)]">
                      {{ getStatusLabel(invoice.status) }}
                    </span>
                  </td>
                  <td>
                    <button @click="openDetailsModal(invoice)" class="details-button">
                      Ver Detalhes
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>

        <!-- Modal de Detalhes -->
        <UniversalModal
          :is-open="isDetailsModalOpen"
          @close="closeDetailsModal"
          :title="`Detalhes da Fatura - ${selectedInvoiceForModal?.period}`"
          size="lg"
        >
          <div v-if="selectedInvoiceForModal" class="invoice-details-content">
            <div class="detail-block-wrapper">
              <div v-for="item in selectedInvoiceForModal.items" :key="item.id" class="detail-block">
                <h5>{{ item.type.charAt(0).toUpperCase() + item.type.slice(1) }}</h5>
                <ul>
                  <li>{{ item.description }}: <strong>{{ item.quantity }} x {{ formatCurrency(item.unit_price) }}</strong></li>
                  <li v-if="item.service_date"><small>Realizado em: {{ formatDate(item.service_date) }}</small></li>
                  <li><strong>Subtotal: {{ formatCurrency(item.total_price) }}</strong></li>
                </ul>
              </div>
            </div>
          </div>
        </UniversalModal>

        <!-- Modal Lançar Serviço Avulso -->
        <UniversalModal
          :is-open="isManualServiceModalOpen"
          @close="closeManualServiceModal"
          title="Lançar Serviço Avulso na Fatura"
          size="md"
        >
          <div class="manual-service-form">
            <div class="form-group">
              <label for="manual-client">Cliente</label>
              <input id="manual-client" type="text" :value="clientName" disabled>
            </div>
            <div class="form-group">
              <label for="manual-period">Competência</label>
              <input id="manual-period" type="text" v-model="selectedPeriod" disabled>
            </div>
            <div class="form-group">
              <label for="manual-service">Serviço</label>
              <select id="manual-service" v-model="manualService.serviceId">
                <option disabled value="">Selecione um serviço</option>
                <option v-for="service in manualServices" :key="service.id" :value="service.id">
                  {{ service.name }}
                </option>
              </select>
            </div>
            <div class="form-group">
              <label for="manual-date">Data de Realização do Serviço</label>
              <input id="manual-date" type="date" v-model="manualService.serviceDate">
            </div>

            <div class="form-group" v-if="isQuantityServiceSelected">
              <label for="manual-quantity">{{ selectedService?.config?.quantity_label || 'Quantidade' }}</label>
              <input
                id="manual-quantity"
                type="number"
                v-model.number="manualService.quantity"
                :placeholder="selectedService?.config?.placeholder || 'Ex: 1'"
                min="1"
              >
            </div>

            <div class="form-actions">
              <button @click="closeManualServiceModal" class="btn-secondary">Cancelar</button>
              <button @click="submitManualService" class="btn-primary" :disabled="isSubmittingManualService">
                {{ isSubmittingManualService ? 'Lançando...' : 'Lançar Serviço' }}
              </button>
            </div>
            <p v-if="manualServiceError" class="error-text">{{ manualServiceError }}</p>
          </div>
        </UniversalModal>

      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, defineProps } from 'vue';
import { useBilling } from '@/composables/useBilling';
import UniversalModal from '@/components/UniversalModal.vue';

const props = defineProps({
  userId: { type: String, default: null },
  clientName: { type: String, default: 'Cliente' }
});

const {
  invoices,
  isLoading,
  error,
  fetchInvoices,
  addManualService,
  manualServices,
  fetchManualServices
} = useBilling();

const selectedPeriod = ref('');
const contentArea = ref(null);
const isDetailsModalOpen = ref(false);
const selectedInvoiceForModal = ref(null);
const isManualServiceModalOpen = ref(false);
const isSubmittingManualService = ref(false);
const manualServiceError = ref('');
const manualService = ref({
  serviceId: '',
  quantity: 1,
  serviceDate: new Date().toISOString().split('T')[0]
});

const isModalView = computed(() => !!props.userId);
const targetUserId = computed(() => props.userId);
const currentInvoice = computed(() => invoices.value.find(inv => inv.period === selectedPeriod.value) || null);

const availablePeriods = computed(() => {
  const periods = invoices.value.map(inv => inv.period);
  if (!periods.includes(selectedPeriod.value) && selectedPeriod.value) {
    periods.unshift(selectedPeriod.value);
  }
  return [...new Set(periods)].sort().reverse();
});

const isQuantityServiceSelected = computed(() => {
  const service = manualServices.value.find(s => s.id === manualService.value.serviceId);
  return service?.type === 'avulso_quantidade';
});

// NOVO: serviço selecionado para usar config (rótulos/placeholder)
const selectedService = computed(() =>
  manualServices.value.find(s => s.id === manualService.value.serviceId) || null
);

const formatCurrency = (value) => {
  if (typeof value !== 'number') value = parseFloat(value || 0);
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
};

const formatDate = (d) => {
  if (!d) return '';
  const date = new Date(d);
  date.setMinutes(date.getMinutes() + date.getTimezoneOffset());
  return date.toLocaleDateString('pt-BR');
};

const handlePeriodChange = () => {
  if (targetUserId.value) {
    fetchInvoices(targetUserId.value, selectedPeriod.value);
  }
};

const openDetailsModal = (invoice) => {
  selectedInvoiceForModal.value = invoice;
  isDetailsModalOpen.value = true;
};

const closeDetailsModal = () => {
  isDetailsModalOpen.value = false;
  selectedInvoiceForModal.value = null;
};

const openManualServiceModal = async () => {
  manualService.value = {
    serviceId: '',
    quantity: 1,
    serviceDate: new Date().toISOString().split('T')[0]
  };
  manualServiceError.value = '';
  // garante que lista vem do /services?manualOnly=1
  await fetchManualServices();
  isManualServiceModalOpen.value = true;
};

const closeManualServiceModal = () => {
  isManualServiceModalOpen.value = false;
};

const submitManualService = async () => {
  manualServiceError.value = '';
  if (!manualService.value.serviceId || !manualService.value.serviceDate) {
    manualServiceError.value = 'Por favor, selecione um serviço e uma data.';
    return;
  }

  isSubmittingManualService.value = true;
  try {
    await addManualService({
      uid: targetUserId.value,
      period: selectedPeriod.value,
      serviceId: manualService.value.serviceId,
      quantity: isQuantityServiceSelected.value ? manualService.value.quantity : null,
      serviceDate: manualService.value.serviceDate
    });
    closeManualServiceModal();
    await fetchInvoices(targetUserId.value, selectedPeriod.value);
  } catch (e) {
    manualServiceError.value = e.message || 'Falha ao lançar serviço.';
  } finally {
    isSubmittingManualService.value = false;
  }
};

const getStatusClass = (status) => {
  const s = status?.toLowerCase();
  if (s === 'paid') return 'status-paid';
  if (s === 'pending') return 'status-open';
  return 'status-default';
};

const getStatusLabel = (status) => {
  const s = status?.toLowerCase();
  if (s === 'paid') return 'Pago';
  if (s === 'pending') return 'Em Aberto';
  return status;
};

const loadInitialData = async () => {
  if (targetUserId.value) {
    const currentPeriod = new Date().toISOString().slice(0, 7);
    selectedPeriod.value = currentPeriod;
    await fetchInvoices(targetUserId.value, currentPeriod);
    await fetchManualServices(); // pré-carrega lista do catálogo
  }
};

onMounted(() => {
  if (props.userId) {
    loadInitialData();
  }
});

watch(() => props.userId, (newId) => {
  if (newId) {
    loadInitialData();
  }
});
</script>

<style scoped>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
.dashboard-wrapper { display: flex; min-height: 100vh; font-family: 'Inter', sans-serif; }
.main-content { flex: 1; display: flex; flex-direction: column; }
.dashboard-content { flex: 1; }
.error-state { padding: 2rem; text-align: center; font-size: 1rem; color: #b91c1c; background-color: #fee2e2; border-radius: 0.5rem; }
.empty-state-full-page { text-align: center; padding: 4rem 1rem; color: #6b7280; }
.filters-and-actions { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; background-color: #fff; padding: 1rem; border-radius: 0.75rem; box-shadow: 0 1px 2px 0 rgba(0,0,0,0.05); }
.filter-group { display: flex; align-items: center; gap: 0.5rem; }
.filter-group label { font-size: 0.875rem; font-weight: 500; color: #374151; }
.filter-group select { padding: 0.5rem; border: 1px solid #d1d5db; border-radius: 6px; font-size: 0.875rem; background-color: #fff; }
.action-button { background-color: #10b981; color: white; border: none; padding: 0.6rem 1.2rem; border-radius: 6px; font-weight: 600; cursor: pointer; transition: background-color 0.2s; display: inline-flex; align-items: center; gap: 0.5rem; }
.action-button:hover { background-color: #059669; }
.stats-cards-grid-5 { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1.5rem; margin-bottom: 2.5rem; }
.stat-card { background-color: #ffffff; border-radius: 0.75rem; padding: 1.5rem; border: 1px solid #e5e7eb; box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05); }
.card-title { font-size: 0.875rem; font-weight: 600; color: #374151; margin: 0 0 0.75rem 0; }
.metric-value { font-size: 2.25rem; font-weight: 700; color: #111827; margin: 0; line-height: 1.2; }
.card-description { font-size: 0.875rem; color: #6b7280; margin: 0.5rem 0 0 0; }
.metric-value.status-text { font-size: 1.25rem; font-weight: 600; }
.table-container { background-color: #ffffff; border-radius: 0.75rem; box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.1); overflow-x: auto; margin-top: 2rem; }
.table-title { font-size: 1.25rem; font-weight: 600; color: #111827; padding: 1.5rem; margin: 0; border-bottom: 1px solid #e5e7eb; }
.history-table { width: 100%; border-collapse: collapse; text-align: left; }
.history-table th, .history-table td { padding: 1rem 1.5rem; border-bottom: 1px solid #e5e7eb; }
.status-badge { padding: 0.25rem 0.75rem; border-radius: 9999px; font-size: 0.8rem; font-weight: 600; display: inline-block; }
.status-paid { background-color: #dcfce7; color: #166534; }
.status-open { background-color: #fef3c7; color: #92400e; }
.details-button { background-color: #2563eb; color: white; border: none; padding: 0.5rem 1rem; border-radius: 6px; font-weight: 500; cursor: pointer; }
.invoice-details-content { padding: 1.5rem 2rem; background-color: #f9fafb; }
.detail-block-wrapper { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 2rem; }
.detail-block h5 { font-size: 1rem; font-weight: 600; color: #374151; border-bottom: 1px solid #e5e7eb; padding-bottom: 0.5rem; margin-bottom: 1rem; }
.detail-block li { padding: 0.25rem 0; color: #4b5563; }
.detail-block li small { color: #6b7280; font-style: italic; }
.manual-service-form { padding: 1rem; display: flex; flex-direction: column; gap: 1.5rem; }
.form-group { display: flex; flex-direction: column; }
.form-group label { margin-bottom: 0.5rem; font-weight: 500; color: #374151; }
.form-group input, .form-group select { padding: 0.75rem; border: 1px solid #d1d5db; border-radius: 6px; font-size: 1rem; }
.form-group input:disabled { background-color: #f3f4f6; }
.form-actions { display: flex; justify-content: flex-end; gap: 1rem; margin-top: 1rem; }
.btn-primary { background-color: #2563eb; color: white; border: none; padding: 0.75rem 1.5rem; border-radius: 6px; font-weight: 600; cursor: pointer; }
.btn-primary:disabled { background-color: #9ca3af; cursor: wait; }
.btn-secondary { background-color: #e5e7eb; color: #374151; border: none; padding: 0.75rem 1.5rem; border-radius: 6px; font-weight: 600; cursor: pointer; }
.error-text { color: #ef4444; font-size: 0.875rem; text-align: center; }

/* Estilos para skeleton loader */
@keyframes pulse {
  50% { opacity: 0.6; }
}
.skeleton-loader { padding: 1rem; }
.sk-header, .sk-card, .sk-row, .sk-filters, .sk-table-header, .sk-card-title, .sk-card-value, .sk-card-description, .sk-cell,
.sk-detail-block, .sk-detail-title, .sk-detail-item, .sk-filter-group, .sk-action-button, .sk-table-title, .sk-table-head, .sk-head-cell { 
  background-color: #e5e7eb; 
  border-radius: 6px; 
  animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite; 
}
.sk-header { height: 38px; width: 40%; margin-bottom: 2rem; }
.sk-filters { height: 60px; margin-bottom: 2rem; border-radius: 0.75rem; display: flex; justify-content: space-between; padding: 1rem; }
.sk-filter-group { width: 200px; height: 36px; }
.sk-action-button { width: 150px; height: 36px; }
.sk-grid-5 { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1.5rem; margin-bottom: 2.5rem; }
.sk-card { height: 140px; border-radius: 0.75rem; padding: 1rem; display: flex; flex-direction: column; }
.sk-card-title { height: 16px; width: 70%; margin-bottom: 1rem; }
.sk-card-value { height: 36px; width: 60%; margin-bottom: 1rem; }
.sk-card-description { height: 14px; width: 80%; }
.sk-table-header { height: 80px; margin-bottom: 0; border-radius: 0.75rem 0.75rem 0 0; display: flex; flex-direction: column; }
.sk-table-title { height: 24px; width: 30%; margin: 1rem; }
.sk-table-head { display: flex; padding: 0 1rem; gap: 1rem; height: 40px; }
.sk-head-cell { flex: 1; height: 20px; }
.sk-table { width: 100%; border-radius: 0 0 0.75rem 0.75rem; }
.sk-row { height: 48px; margin-bottom: 0.5rem; display: flex; gap: 1rem; padding: 0 1rem; }
.sk-cell { flex: 1; height: 20px; }
.sk-row:last-child { margin-bottom: 0; }

/* Estilos para o skeleton do modal de detalhes */
.invoice-details-skeleton { padding: 0; }
.sk-detail-block { padding: 1rem; margin-bottom: 1rem; border-radius: 0.5rem; }
.sk-detail-title { height: 20px; width: 40%; margin-bottom: 1rem; }
.sk-detail-item { height: 16px; width: 80%; margin-bottom: 0.5rem; }
.sk-detail-item:last-child { margin-bottom: 0; }
</style>
