<template>
  <div class="stats-cards-grid-small" ref="gridEl">
    <div class="stat-card" ref="cardEls">
      <h3 class="card-title">Previsão de Custo Total</h3>
      <div v-if="billingSummary.isLoading" class="skeleton-group">
        <div class="skeleton-line h-8 w-60"></div>
        <div class="skeleton-line h-4 w-40 mt-2"></div>
      </div>
      <div v-else-if="billingSummary.error" class="error-billing">
        {{ billingSummary.error }}
      </div>
      <div v-else-if="billingSummary.data">
        <p class="metric-value total-cost">
          {{ formatCurrency(display.totalCost) }}
        </p>
        <p class="card-description-small">
          Armazenamento + Expedições
        </p>
      </div>
    </div>

    <div class="stat-card" ref="cardEls">
      <h3 class="card-title">Volume Consumido</h3>
      <p class="metric-value">
        {{ display.volumeConsumido.toFixed(4) }}
        <span class="metric-unit">m³</span>
      </p>
      <p class="card-description-small">
        de {{ volumeContratado.toFixed(2) }} m³ contratado
      </p>
    </div>

    <div class="stat-card" ref="cardEls">
      <h3 class="card-title">% de Ocupação</h3>
      <p class="metric-value">
        {{ display.percentualOcupacao.toFixed(1) }}<span class="metric-unit">%</span>
      </p>
      <div class="progress-bar-container">
        <div class="progress-bar" :style="{ width: `${display.percentualOcupacao}%` }"></div>
      </div>
    </div>

    <div class="stat-card" ref="cardEls">
        <h3 class="card-title">Custo Exped. Comum</h3>
        <div v-if="billingSummary.isLoading" class="skeleton-group">
            <div class="skeleton-line h-8 w-60"></div>
        </div>
        <div v-else-if="billingSummary.data">
            <p class="metric-value exped-cost">
                {{ formatCurrency(display.expedicaoComumCost) }}
            </p>
             <p class="card-description-small">Taxas do mês atual</p>
        </div>
    </div>

    <div class="stat-card" ref="cardEls">
        <h3 class="card-title">Custo Exped. Premium</h3>
        <div v-if="billingSummary.isLoading" class="skeleton-group">
            <div class="skeleton-line h-8 w-60"></div>
        </div>
        <div v-else-if="billingSummary.data">
            <p class="metric-value exped-cost">
                {{ formatCurrency(display.expedicaoPremiumCost) }}
            </p>
            <p class="card-description-small">Taxas do mês atual</p>
        </div>
    </div>

    <!-- NOVO: Card de Armazenamento Mensal -->
    <div v-if="billingSummary.data?.monthlyStorageCost > 0" class="stat-card monthly-storage" ref="cardEls">
      <h3 class="card-title">Armazenamento Mensal</h3>
      <div v-if="billingSummary.isLoading" class="skeleton-group">
        <div class="skeleton-line h-8 w-60"></div>
      </div>
      <div v-else-if="billingSummary.data">
        <p class="metric-value monthly-cost">
          {{ formatCurrency(display.monthlyStorageCost) }}
        </p>
        <p class="card-description-small">
          {{ billingSummary.data.monthlyStorageDetails?.length || 0 }} SKU(s) mensais
        </p>
      </div>
    </div>
  </div>
</template>

<script>
import { defineComponent, ref, reactive, watch, onMounted, nextTick } from 'vue'
import { gsap } from 'gsap'

export default defineComponent({
  name: 'StatsCardGrid',
  props: {
    isLoading: { type: Boolean, default: false },
    billingSummary: { type: Object, required: true },
    volumeConsumido: { type: Number, required: true },
    volumeContratado: { type: Number, required: true },
    percentualOcupacao: { type: Number, required: true },
    // A prop expeditedSalesCount não é mais necessária aqui
  },
  setup(props) {
    const display = reactive({
      totalCost: 0,
      volumeConsumido: 0,
      percentualOcupacao: 0,
      expedicaoComumCost: 0,
      expedicaoPremiumCost: 0,
      monthlyStorageCost: 0,
    })

    const cardEls = ref([])

    const formatCurrency = (value) => {
      if (typeof value !== 'number' || Number.isNaN(value)) return 'R$ 0,00'
      return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
    }

    const tweenValue = (target, key, endValue, duration = 0.8) => {
      gsap.to(target, {
        [key]: endValue || 0,
        duration,
        ease: 'power2.out',
      })
    }

    const animateIn = () => {
      if (props.isLoading) return;
      nextTick(() => {
        gsap.from(cardEls.value, {
            opacity: 0,
            y: 16,
            duration: 0.5,
            ease: 'power2.out',
            stagger: 0.08,
        });
      });
    }

    watch(() => props.billingSummary, (val) => {
      if (val?.data) {
        tweenValue(display, 'totalCost', val.data.totalCost)
        tweenValue(display, 'expedicaoComumCost', val.data.expedicaoComumCost)
        tweenValue(display, 'expedicaoPremiumCost', val.data.expedicaoPremiumCost)
        tweenValue(display, 'monthlyStorageCost', val.data.monthlyStorageCost || 0)
      }
    }, { deep: true, immediate: true })

    watch(() => props.volumeConsumido, (val) => tweenValue(display, 'volumeConsumido', val), { immediate: true })
    watch(() => props.percentualOcupacao, (val) => tweenValue(display, 'percentualOcupacao', val), { immediate: true })
    
    watch(() => props.isLoading, (loading) => {
        if(!loading) {
            animateIn();
        }
    });

    onMounted(() => {
      if(!props.isLoading) {
        animateIn();
      }
    })

    return {
      formatCurrency,
      display,
      cardEls,
    }
  },
})
</script>

<style scoped>
.stats-cards-grid-small {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 14px;
}

.stat-card {
  position: relative;
  background-color: #ffffff;
  border: 1px solid #e7e8ec;
  border-radius: 14px;
  padding: 16px 16px 18px;
  box-shadow: 0 6px 18px rgba(17, 24, 39, 0.06);
  display: flex;
  flex-direction: column;
  transition: transform .2s ease, box-shadow .2s ease;
}

.stat-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 10px 24px rgba(17, 24, 39, 0.08);
}

.card-title {
  font-size: 0.9rem;
  font-weight: 600;
  color: #374151;
  margin: 2px 0 10px;
  letter-spacing: 0.2px;
}

.metric-value {
  font-size: 1.9rem;
  font-weight: 700;
  color: #111827;
  margin: 0;
  line-height: 1.15;
}

.metric-unit {
  font-size: 1rem;
  font-weight: 500;
  color: #6b7280;
  margin-left: 4px;
}

.card-description-small {
  font-size: 0.78rem;
  color: #6b7280;
  margin-top: 6px;
  line-height: 1.45;
}

.total-cost { color: #16a34a; }
.exped-cost { color: #4f46e5; }
.monthly-cost { color: #28a745; }

.monthly-storage {
  border-left: 4px solid #28a745;
}

.error-billing {
  font-size: 0.9rem;
  color: #e11d48;
}

.progress-bar-container {
  width: 100%;
  background-color: #eef2ff;
  border-radius: 9999px;
  height: 8px;
  overflow: hidden;
  margin-top: auto;
  border: 1px solid #e5e7eb;
}

.progress-bar {
  height: 100%;
  width: 0%;
  background: linear-gradient(90deg, #2563eb, #3b82f6);
  border-radius: 9999px;
  transition: width 0.8s cubic-bezier(0.25, 0.46, 0.45, 0.94);
}

.skeleton-group {
  display: flex;
  flex-direction: column;
}
.skeleton-line {
  border-radius: 8px;
  background: linear-gradient(90deg, #f2f4f8 25%, #e9eef7 50%, #f2f4f8 75%);
  background-size: 200% 100%;
  animation: shimmer 1.5s ease-in-out infinite;
}
.h-8 { height: 32px; }
.h-4 { height: 16px; }
.w-60 { width: 60%; }
.w-40 { width: 40%; }
.mt-2 { margin-top: 8px; }

@keyframes shimmer {
  0%   { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

@media (max-width: 360px) {
  .metric-value { font-size: 1.7rem; }
  .card-title { font-size: 0.86rem; }
}
</style>
