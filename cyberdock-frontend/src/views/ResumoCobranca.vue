<template>
    <div class="dashboard-wrapper" :class="{ 'is-modal-view': isModalView }">
        <SidebarComponent v-if="!isModalView" />
        <div class="main-content">
            <TopbarComponent v-if="!isModalView" />
            <div class="dashboard-content" ref="contentArea">

                <div class="header" v-if="!isModalView">
                    <h1 class="dashboard-title">Resumo de Cobrança</h1>
                    <p class="dashboard-subtitle">Gerencie suas cobranças em nosso site.</p>
                </div>

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

                <template v-else-if="invoices.length > 0">
                    <div class="filters">
                        <div class="filter-group">
                            <label for="period-filter">Selecione a Competência:</label>
                            <select id="period-filter" v-model="selectedPeriod" @change="handlePeriodChange" class="filter-select">
                                <option v-for="invoice in invoices" :key="invoice.id" :value="invoice.period">
                                    {{ invoice.period }}
                                </option>
                            </select>
                        </div>
                    </div>

                    <div v-if="currentInvoice" class="stats-cards-grid-5">
                        <div class="stat-card">
                            <h3 class="card-title">Valor da Fatura</h3>
                            <p class="metric-value">{{ formattedAnimatedTotalAmount }}</p>
                            <p class="card-description">Vencimento: {{ currentInvoice.dueDate }}</p>
                        </div>
                        <div class="stat-card">
                            <h3 class="card-title">Status da Fatura</h3>
                            <p class="metric-value status-text">
                                <span :class="['status-badge', currentInvoice.status === 'paid' ? 'status-paid' : 'status-open']">
                                    {{ currentInvoice.status === 'paid' ? 'Pago' : 'Em Aberto' }}
                                </span>
                            </p>
                            <p class="card-description" v-if="currentInvoice.paymentDate">Pago em: {{ currentInvoice.paymentDate }}</p>
                            <p class="card-description" v-else>Aguardando pagamento.</p>
                        </div>
                        <div class="stat-card">
                            <h3 class="card-title">Armazenamento</h3>
                            <p class="metric-value">{{ animatedStorage.toFixed(0) }} <span class="metric-unit">item(s)</span></p>
                            <p class="card-description">Itens de armazenamento cobrados.</p>
                        </div>
                        <div class="stat-card">
                            <h3 class="card-title">Expedição Comum</h3>
                            <p class="metric-value">{{ animatedCommonShipments.toFixed(0) }}</p>
                            <p class="card-description">Unidades expedidas.</p>
                        </div>
                         <div class="stat-card">
                            <h3 class="card-title">Expedição Premium</h3>
                            <p class="metric-value">{{ animatedPremiumShipments.toFixed(0) }}</p>
                            <p class="card-description">Unidades expedidas.</p>
                        </div>
                    </div>

                    <div class="table-container">
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
                                <tr v-for="invoice in invoices" :key="invoice.id" class="invoice-row">
                                    <td class="period-code">{{ invoice.period }}</td>
                                    <td>{{ formatCurrency(invoice.totalAmount) }}</td>
                                    <td>{{ invoice.dueDate }}</td>
                                    <td>
                                        <span :class="['status-badge', invoice.status === 'paid' ? 'status-paid' : 'status-open']">
                                            {{ invoice.status === 'paid' ? 'Pago' : 'Em Aberto' }}
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
                
                <div v-else class="empty-state-full-page">
                    <h3>Nenhuma fatura encontrada</h3>
                    <p>Este usuário ainda não possui faturas.</p>
                </div>

                <UniversalModal
                    :is-open="isDetailsModalOpen"
                    @close="closeDetailsModal"
                    :title="`Detalhes da Fatura - ${selectedInvoiceForModal?.period}`"
                    size="lg"
                >
                    <div v-if="isLoading" class="skeleton-loader invoice-details-skeleton">
                        <div class="detail-block-wrapper">
                            <div v-for="n in 3" :key="n" class="detail-block sk-detail-block">
                                <div class="sk-detail-title"></div>
                                <div class="sk-detail-item" v-for="m in 2" :key="m"></div>
                            </div>
                        </div>
                    </div>
                    <div v-else-if="selectedInvoiceForModal" class="invoice-details-content">
                        <div class="detail-block-wrapper">
                            <div v-for="item in selectedInvoiceForModal.items" :key="item.description" class="detail-block">
                                <h5>{{ item.type.charAt(0).toUpperCase() + item.type.slice(1) }}</h5>
                                <ul>
                                    <li>{{ item.description }}: <strong>{{ item.quantity }} x {{ formatCurrency(item.unit_price) }}</strong></li>
                                    <li><strong>Subtotal: {{ formatCurrency(item.total_price) }}</strong></li>
                                </ul>
                            </div>
                        </div>
                    </div>
                </UniversalModal>
            </div>
        </div>
    </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, nextTick, defineProps } from 'vue';
import { useBilling } from '@/composables/useBilling';
import { useAuth } from '@/composables/useAuth';
import gsap from 'gsap';
import UniversalModal from '@/components/UniversalModal.vue';
import SidebarComponent from '@/components/SidebarComponent.vue';
import TopbarComponent from '@/components/TopbarComponent.vue';

const props = defineProps({
    userId: {
        type: String,
        default: null
    }
});

const { user } = useAuth();
const { invoices, isLoading, error, fetchInvoices } = useBilling();

const selectedPeriod = ref('');
const contentArea = ref(null);
const isDetailsModalOpen = ref(false);
const selectedInvoiceForModal = ref(null);

const animatedTotalAmount = ref(0);
const animatedStorage = ref(0);
const animatedCommonShipments = ref(0);
const animatedPremiumShipments = ref(0);

const isModalView = computed(() => !!props.userId);
const targetUserId = computed(() => props.userId || user.value?.uid);
const currentInvoice = computed(() => invoices.value.find(inv => inv.period === selectedPeriod.value) || null);
const formattedAnimatedTotalAmount = computed(() => formatCurrency(animatedTotalAmount.value));

const formatCurrency = (value) => {
    if (typeof value !== 'number') return 'R$ 0,00';
    return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
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

const animateContentIn = () => {
    nextTick(() => {
        if (!contentArea.value) return;
        
        const tl = gsap.timeline({ defaults: { ease: 'power3.out' } });
        
        tl.from(contentArea.value.querySelector('.header'), { opacity: 0, y: -20, duration: 0.5, clearProps: 'all' })
          .from(contentArea.value.querySelectorAll('.stats-cards-grid-5 .stat-card'), { opacity: 0, y: 20, stagger: 0.1, duration: 0.5, clearProps: 'all' }, "-=0.2")
          .from(contentArea.value.querySelector('.table-container'), { opacity: 0, y: 20, duration: 0.5, clearProps: 'all' }, "-=0.3");
    });
};

watch(currentInvoice, (newInvoice) => {
    if (!newInvoice || !newInvoice.items) {
        gsap.to(animatedTotalAmount, { duration: 0.5, value: 0 });
        gsap.to(animatedStorage, { duration: 0.5, value: 0 });
        gsap.to(animatedCommonShipments, { duration: 0.5, value: 0 });
        gsap.to(animatedPremiumShipments, { duration: 0.5, value: 0 });
        return;
    }
    
    const duration = 0.8;
    const ease = 'power2.out';

    gsap.to(animatedTotalAmount, { duration, value: newInvoice.totalAmount, ease });

    const totalStorageUnits = newInvoice.items
        .filter(i => i.type === 'storage')
        .reduce((acc, item) => acc + item.quantity, 0);
    gsap.to(animatedStorage, { duration, value: totalStorageUnits, ease });

    const commonShipmentItem = newInvoice.items.find(i => i.description === 'Expedição Comum');
    gsap.to(animatedCommonShipments, { duration, value: commonShipmentItem?.quantity || 0, ease });
    
    const premiumShipmentItem = newInvoice.items.find(i => i.description === 'Expedição Premium');
    gsap.to(animatedPremiumShipments, { duration, value: premiumShipmentItem?.quantity || 0, ease });

}, { immediate: true, deep: true });

watch(isLoading, (loading) => {
    if (!loading && !error.value && invoices.value.length > 0) {
        animateContentIn();
    }
});

const loadInitialData = async () => {
    if (targetUserId.value) {
        const currentPeriod = new Date().toISOString().slice(0, 7);
        await fetchInvoices(targetUserId.value, currentPeriod);
        if (invoices.value.length > 0 && !selectedPeriod.value) {
            selectedPeriod.value = invoices.value[0].period;
        }
    }
};

watch(targetUserId, (newId) => {
    if (newId) {
        loadInitialData();
    }
}, { immediate: true });

onMounted(() => {
    if (targetUserId.value) {
        loadInitialData();
    }
});
</script>

<style scoped>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');

.dashboard-wrapper { display: flex; min-height: 100vh; font-family: 'Inter', sans-serif; background-color: #f3f4f6; }
.dashboard-wrapper.is-modal-view { min-height: auto; background-color: #fff; }
.main-content { flex: 1; display: flex; flex-direction: column; }
.dashboard-content { flex: 1; padding: 2rem; }
.is-modal-view .dashboard-content { padding: 1rem; }

.header { margin-bottom: 2rem; }
.dashboard-title { font-size: 1.875rem; font-weight: 700; color: #111827; margin: 0; }
.dashboard-subtitle { margin-top: 0.25rem; font-size: 0.875rem; color: #6b7280; }

.error-state { padding: 2rem; text-align: center; font-size: 1rem; color: #b91c1c; background-color: #fee2e2; border-radius: 0.5rem; }
.empty-state-full-page { text-align: center; padding: 4rem 1rem; color: #6b7280; }
.empty-state-full-page h3 { font-size: 1.25rem; font-weight: 600; color: #111827; }
.empty-state-full-page p { font-size: 1rem; }

.filters { margin-bottom: 2rem; background-color: #fff; padding: 1rem; border-radius: 0.75rem; box-shadow: 0 1px 2px 0 rgba(0,0,0,0.05); }
.filter-group { display: flex; align-items: center; gap: 0.5rem; }
.filter-group label { font-size: 0.875rem; font-weight: 500; color: #374151; }
.filter-group select { padding: 0.5rem; border: 1px solid #d1d5db; border-radius: 6px; font-size: 0.875rem; background-color: #fff; }

.stats-cards-grid-5 { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1.5rem; margin-bottom: 2.5rem; }
.stat-card { background-color: #ffffff; border-radius: 0.75rem; padding: 1.5rem; border: 1px solid #e5e7eb; box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05); }
.card-title { font-size: 0.875rem; font-weight: 600; color: #374151; margin: 0 0 0.75rem 0; }
.metric-value { font-size: 2.25rem; font-weight: 700; color: #111827; margin: 0; line-height: 1.2; }
.metric-unit { font-size: 1.5rem; font-weight: 500; color: #6b7280; margin-left: 0.25rem; }
.card-description { font-size: 0.875rem; color: #6b7280; margin: 0.5rem 0 0 0; }
.metric-value.status-text { font-size: 1.25rem; font-weight: 600; }

.table-container { background-color: #ffffff; border-radius: 0.75rem; box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.1); overflow-x: auto; }
.table-title { font-size: 1.25rem; font-weight: 600; color: #111827; padding: 1.5rem; margin: 0; border-bottom: 1px solid #e5e7eb; }
.history-table { width: 100%; border-collapse: collapse; text-align: left; }
.history-table th, .history-table td { padding: 1rem 1.5rem; border-bottom: 1px solid #e5e7eb; vertical-align: middle; white-space: nowrap; }
.history-table thead th { font-size: 0.75rem; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; background-color: #f9fafb; }
.history-table tbody tr:last-child td { border-bottom: none; }
.invoice-row:hover { background-color: #f9fafb; }
.period-code { font-weight: 600; color: #2563eb; }

.status-badge { padding: 0.25rem 0.75rem; border-radius: 9999px; font-size: 0.8rem; font-weight: 600; display: inline-block; }
.status-paid { background-color: #dcfce7; color: #166534; }
.status-open { background-color: #fef3c7; color: #92400e; }
.details-button { background-color: #2563eb; color: white; border: none; padding: 0.5rem 1rem; border-radius: 6px; font-weight: 500; cursor: pointer; transition: background-color 0.2s; }
.details-button:hover { background-color: #1d4ed8; }

.invoice-details-content { padding: 1.5rem 2rem; background-color: #f9fafb; }
.detail-block-wrapper { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 2rem; }
.detail-block h5 { font-size: 1rem; font-weight: 600; color: #374151; border-bottom: 1px solid #e5e7eb; padding-bottom: 0.5rem; margin-bottom: 1rem; text-transform: capitalize; }
.detail-block ul { list-style: none; padding: 0; margin: 0; }
.detail-block li { padding: 0.25rem 0; color: #4b5563; font-size: 0.875rem; }
.detail-block li strong { color: #111827; }

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
