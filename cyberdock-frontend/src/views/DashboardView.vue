<template>
  <div class="dashboard-wrapper">
    <SidebarComponent />
    <div class="main-content">
      <TopbarComponent />

      <div class="dashboard-content" ref="rootEl">
        <!-- Toolbar -->
        <div class="toolbar">
          <div class="toolbar-text">
            <h1 class="toolbar-title">Dashboard</h1>
            <p class="toolbar-desc">Visão geral das vendas, armazenagem e faturamento do período selecionado.</p>
          </div>
          <select class="period-select" v-model="period">
            <option>Este mês</option>
            <option>Últimos 30 dias</option>
            <option>Últimos 7 dias</option>
          </select>
        </div>

        <!-- Cards Topo (dados reais) -->
        <div class="grid grid-4" ref="cardsRow">
          <div class="card" :class="{ skeleton: loadingTop }">
            <div class="card-icon">
              <span class="icon">
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"
                     viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                     stroke-linecap="round" stroke-linejoin="round" class="icon icon-tabler icons-tabler-outline icon-tabler-chart-line">
                  <path stroke="none" d="M0 0h24v24H0z" fill="none"/>
                  <path d="M4 19l16 0" />
                  <path d="M4 15l4 -6l4 2l4 -5l4 4" />
                </svg>
              </span>
            </div>
            <div class="card-title">Total de Vendas<br />no Período</div>
            <div class="card-value">{{ totalSales }} <span class="unit">vendas</span></div>
            <div class="card-foot">Pendentes: {{ pendingSales }}</div>
          </div>

          <div class="card" :class="{ skeleton: loadingTop }">
            <div class="card-icon">
              <span class="icon">
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"
                     viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                     stroke-linecap="round" stroke-linejoin="round" class="icon icon-tabler icons-tabler-outline icon-tabler-truck">
                  <path stroke="none" d="M0 0h24v24H0z" fill="none"/>
                  <path d="M7 17m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
                  <path d="M17 17m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
                  <path d="M5 17h-2v-11a1 1 0 0 1 1 -1h9v12m-4 0h6m4 0h2v-6h-8m0 -5h5l3 5" />
                </svg>
              </span>
            </div>
            <div class="card-title">Vendas<br />a Despachar</div>
            <div class="card-value">{{ pendingSales }} <span class="unit">pendentes</span></div>
            <button class="link-like" :disabled="loadingTop">Ver detalhes</button>
          </div>

          <div class="card" :class="{ skeleton: storageLoading }">
            <div class="card-icon">
              <span class="icon">
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"
                     viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                     stroke-linecap="round" stroke-linejoin="round" class="icon icon-tabler icons-tabler-outline icon-tabler-box">
                  <path stroke="none" d="M0 0h24v24H0z" fill="none"/>
                  <path d="M12 3l8 4.5l0 9l-8 4.5l-8 -4.5l0 -9l8 -4.5" />
                  <path d="M12 12l8 -4.5" />
                  <path d="M12 12l0 9" />
                  <path d="M12 12l-8 -4.5" />
                </svg>
              </span>
            </div>
            <div class="card-title">Armazenamento<br />Atual</div>
            <div class="card-value">{{ volumeConsumidoFmt }} <span class="unit">m³</span></div>
            <div class="card-foot muted">Capacidade contratada: {{ volumeContratadoFmt }} m³</div>
          </div>

          <div class="card" :class="{ skeleton: storageLoading }">
            <div class="card-icon">
              <span class="icon">
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"
                     viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                     stroke-linecap="round" stroke-linejoin="round" class="icon icon-tabler icons-tabler-outline icon-tabler-clipboard">
                  <path stroke="none" d="M0 0h24v24H0z" fill="none"/>
                  <path d="M9 5h-2a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-12a2 2 0 0 0 -2 -2h-2" />
                  <path d="M9 3m0 2a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v0a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2z" />
                </svg>
              </span>
            </div>
            <div class="card-title">Fatura<br />Atual</div>
            <div class="card-value">
              {{ faturaTotalFmt }}
            </div>
            <div class="card-foot">em aberto</div>
          </div>
        </div>

        <!-- Dois gráficos (ApexCharts) -->
        <div class="grid grid-2" ref="chartsRow">
          <!-- Vendas por Status -->
          <div class="card chart-card" ref="statusCard" :class="{ skeleton: salesLoading }">
            <div class="card-title plain">Vendas por Status</div>
            <VueApexCharts type="bar" height="260" :options="statusChartOptions" :series="statusSeries" />
          </div>

          <!-- Vendas por Dia -->
          <div class="card chart-card" ref="dailyCard" :class="{ skeleton: loadingTop }">
            <div class="card-title plain">Vendas por Dia</div>
            <VueApexCharts type="bar" height="260" :options="dailyChartOptions" :series="dailySeries" />
          </div>
        </div>

        <!-- Produtos em estoque -->
        <div class="card" :class="{ skeleton: storageLoading }" ref="tableRow">
          <div class="card-title plain">Produtos em Estoque</div>
          <div class="table">
            <div class="thead">
              <div>SKU</div>
              <div>DESCRIÇÃO DO PRODUTO</div>
              <div>DIMENSÕES (cm)</div>
              <div>QTDE, EM ESTOQUE</div>
              <div>VOLUME TOTAL (m³)</div>
            </div>

            <div class="trow" v-for="(p, i) in skus" :key="i">
              <div class="mono">{{ p.sku }}</div>
              <div class="ellipsis">{{ p.descricao }}</div>
              <div>
                <template v-if="p.dimensoes">
                  {{ p.dimensoes.comprimento }} × {{ p.dimensoes.largura }} × {{ p.dimensoes.altura }}
                </template>
              </div>
              <div>{{ p.quantidade }}</div>
              <div>{{ (calcVol(p)).toFixed(2) }}</div>
            </div>

            <div v-if="!skus.length && !storageLoading" class="empty">Nenhum produto cadastrado.</div>
          </div>
        </div>
      </div> <!-- /dashboard-content -->
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, computed, watch, nextTick } from 'vue'
import SidebarComponent from '../components/SidebarComponent.vue'
import TopbarComponent from '../components/TopbarComponent.vue'
import VueApexCharts from 'vue3-apexcharts'
import { gsap } from 'gsap'

import { useAuth } from '@/composables/useAuth'
import { useSales } from '@/composables/useSales'
import { useUserStorage } from '@/composables/useUserStorage'

/* -------------------- Estado / dados -------------------- */
const { user, isAuthReady } = useAuth()
const period = ref('Este mês')
const loadingTop = ref(true)

const { sales, isLoading: salesLoading, fetchSales } = useSales()

// storage/billing reais
const userId = computed(() => user.value?.uid || null)
const {
  skus,
  volumeConsumido,
  volumeContratado,
  billingSummary,
  isLoading: storageLoadingRaw,
  calcularVolumePorSku
} = useUserStorage(userId)

const storageLoading = computed(() => storageLoadingRaw.value || billingSummary.value.isLoading)

const volumeConsumidoFmt = computed(() => (volumeConsumido.value || 0).toFixed(2))
const volumeContratadoFmt = computed(() => (volumeContratado.value || 0).toFixed(2))
const faturaTotalFmt = computed(() => {
  const total = billingSummary.value?.data?.totalCost || 0
  return total.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
})

/* -------------------- Filtros e agregações -------------------- */
const dateFrom = computed(() => {
  const now = new Date()
  if (period.value === 'Últimos 7 dias') {
    const d = new Date(now); d.setDate(d.getDate() - 6); d.setHours(0, 0, 0, 0); return d
  }
  if (period.value === 'Últimos 30 dias') {
    const d = new Date(now); d.setDate(d.getDate() - 29); d.setHours(0, 0, 0, 0); return d
  }
  // Este mês
  const d = new Date(now.getFullYear(), now.getMonth(), 1); d.setHours(0, 0, 0, 0); return d
})

const salesFiltered = computed(() => {
  const from = dateFrom.value.getTime()
  return (sales.value || [])
    .filter(s => new Date(s.sale_date).getTime() >= from)
    .sort((a, b) => new Date(b.sale_date) - new Date(a.sale_date))
})

const totalSales = computed(() => salesFiltered.value.length)

// ML status: shipped|delivered|not_delivered|cancelled NÃO contam como “a despachar”
const shippedRegex = /(shipped|delivered|not_delivered|cancelled)/i
const pendingSales = computed(() =>
  salesFiltered.value.filter(s => !shippedRegex.test(String(s.shipping_status || ''))).length
)

/* -------------------- Helpers -------------------- */
const calcVol = (p) => calcularVolumePorSku(p)
const normalizeStatus = (s) => String(s || 'pending').replace(/_/g, ' ')

/* -------------------- ApexCharts - Séries e Opções -------------------- */
/** Vendas por Dia (agregado por data real, normalizando para ISO UTC) **/
const dailyBuckets = computed(() => {
  const map = new Map() // key: YYYY-MM-DD, value: count
  for (const s of salesFiltered.value) {
    const d = new Date(s.sale_date)
    const iso = d.toISOString().slice(0, 10) // YYYY-MM-DD em UTC
    map.set(iso, (map.get(iso) || 0) + 1)
  }
  const months = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']
  return Array.from(map.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([iso, value]) => {
      const [, m, d] = iso.split('-').map(n => Number(n))
      const label = `${String(d).padStart(2, '0')} ${months[m - 1]}`
      return { label, value }
    })
})
const dailySeries = computed(() => [{
  name: 'Vendas',
  data: dailyBuckets.value.map(d => d.value)
}])
const dailyChartOptions = computed(() => ({
  chart: { type: 'bar', animations: { enabled: true, easing: 'easeinout', speed: 450 }, toolbar: { show: false } },
  tooltip: { theme: 'light' },
  plotOptions: { bar: { borderRadius: 6, columnWidth: '45%' } },
  dataLabels: { enabled: false },
  xaxis: { categories: dailyBuckets.value.map(d => d.label), labels: { rotate: -45 } },
  yaxis: { labels: { formatter: (v) => Math.trunc(v) } },
  grid: { borderColor: '#f1f5f9' }
}))

/** Vendas por Status **/
const statusBuckets = computed(() => {
  const map = new Map()
  for (const s of salesFiltered.value) {
    const lbl = normalizeStatus(s.shipping_status)
    map.set(lbl, (map.get(lbl) || 0) + 1)
  }
  const arr = Array.from(map.entries()).map(([label, value]) => ({ label, value }))
  arr.sort((a, b) => b.value - a.value)
  return arr.slice(0, 9)
})
const statusSeries = computed(() => [{
  name: 'Vendas',
  data: statusBuckets.value.map(d => d.value)
}])
const statusChartOptions = computed(() => ({
  chart: { type: 'bar', animations: { enabled: true, easing: 'easeinout', speed: 450 }, toolbar: { show: false } },
  tooltip: { theme: 'light' },
  plotOptions: { bar: { borderRadius: 6, columnWidth: '50%' } },
  dataLabels: { enabled: false },
  xaxis: { categories: statusBuckets.value.map(d => d.label), labels: { trim: true, hideOverlappingLabels: true } },
  yaxis: { labels: { formatter: (v) => Math.trunc(v) } },
  grid: { borderColor: '#f1f5f9' }
}))

/* -------------------- GSAP: animações estáveis com cleanup -------------------- */
const rootEl = ref(null)
const cardsRow = ref(null)
const chartsRow = ref(null)
const statusCard = ref(null)
const dailyCard = ref(null)
const tableRow = ref(null)
let gsapCtx = null

function runEnterAnimations() {
  if (!rootEl.value) return
  // Usa context para escopo + cleanup
  gsapCtx = gsap.context(() => {
    // Cards do topo
    if (cardsRow.value) {
      gsap.from(cardsRow.value.children, {
        opacity: 0, y: 14, duration: 0.5, stagger: 0.08, ease: 'power2.out'
      })
    }
    // Contêineres de gráficos
    if (chartsRow.value) {
      gsap.from(chartsRow.value.children, {
        opacity: 0, y: 16, duration: 0.5, delay: 0.1, stagger: 0.1, ease: 'power2.out'
      })
    }
    // Tabela de estoque
    if (tableRow.value) {
      gsap.from(tableRow.value, { opacity: 0, y: 12, duration: 0.5, delay: 0.2, ease: 'power2.out' })
    }
  }, rootEl)
}

async function softRefreshCharts() {
  // Micro fade/slide só nos cards de gráfico ao atualizar dados/período
  await nextTick()
  const els = [statusCard.value, dailyCard.value].filter(Boolean)
  if (!els.length) return
  gsap.killTweensOf(els) // evita overlap
  gsap.fromTo(els, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: 0.35, ease: 'power2.out', stagger: 0.05 })
}

/* -------------------- Lifecycle -------------------- */
onMounted(async () => {
  const waitAuth = () => new Promise(res => {
    if (isAuthReady.value) return res()
    const t = setInterval(() => { if (isAuthReady.value) { clearInterval(t); res() } }, 50)
  })
  await waitAuth()
  await fetchSales()
  loadingTop.value = false
  runEnterAnimations()
})

onUnmounted(() => {
  if (gsapCtx && typeof gsapCtx.revert === 'function') {
    gsapCtx.revert() // cleanup total das animações criadas dentro do context
  }
})

// atualiza gráficos quando muda o período ou as vendas
watch([period, sales], () => {
  softRefreshCharts()
})
</script>

<style scoped>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');

.dashboard-wrapper {
  display: flex;
  min-height: 100vh;
  font-family: 'Inter', sans-serif;
  background: #f3f4f6;
}

.main-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

/* centro */
.dashboard-content {
  margin: auto;
  width: 100%;
  max-width: 1400px;
  padding: 24px;
}

/* toolbar */
.toolbar {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 22px;
}

.toolbar-text {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.toolbar-title {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: #111827;
}

.toolbar-desc {
  margin: 0;
  font-size: 12.5px;
  color: #6b7280;
}

.period-select {
  border: 1px solid #e5e7eb;
  background: #fff;
  border-radius: 10px;
  padding: 10px 12px;
  font-size: 14px;
  color: #111827;
  outline: none;
}

/* grids */
.grid {
  display: grid;
  gap: 24px;
}

.grid-4 {
  grid-template-columns: repeat(4, 1fr);
  margin-bottom: 10px;
}

.grid-2 {
  grid-template-columns: 1.1fr 1fr;
  margin-bottom: 10px;
}

@media (max-width:1100px) {
  .grid-4 {
    grid-template-columns: repeat(2, 1fr)
  }

  .grid-2 {
    grid-template-columns: 1fr
  }
}

@media (max-width:620px) {
  .grid-4 {
    grid-template-columns: 1fr
  }
}

/* cards */
.card {
  position: relative;
  background: #fff;
  border: 1px solid #eef0f3;
  border-radius: 14px;
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  box-shadow: 0 1px 0 rgba(17, 24, 39, 0.03);
}

.card-icon {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: #eef2ff;
  display: grid;
  place-items: center;
}

.icon {
  font-size: 18px;
}

.card-title {
  font-weight: 600;
  color: #111827;
  line-height: 1.15;
}

.card-title.plain {
  margin-bottom: 6px;
}

.card-value {
  font-size: 28px;
  font-weight: 700;
  color: #111827;
  letter-spacing: -0.01em;
}

.unit {
  font-size: 14px;
  font-weight: 600;
  color: #6b7280;
  margin-left: 4px;
}

.sup {
  font-size: 60%;
  vertical-align: top;
  margin-left: 1px;
}

.card-foot {
  font-size: 12.5px;
  color: #111827;
}

.card-foot.muted,
.muted {
  color: #6b7280;
}

/* links */
.link-like {
  background: transparent;
  border: none;
  color: #3b82f6;
  font-weight: 600;
  padding: 0;
  width: fit-content;
  cursor: pointer;
}

.link-like:disabled {
  color: #9ca3af;
  cursor: default;
}

/* skeleton */
.skeleton * {
  pointer-events: none;
  color: transparent !important;
}

.skeleton {
  overflow: hidden;
  position: relative;
}

.skeleton::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, rgba(0, 0, 0, 0.04) 25%, rgba(0, 0, 0, 0.08) 37%, rgba(0, 0, 0, 0.04) 63%);
  animation: shimmer 1.25s infinite;
}

@keyframes shimmer {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(100%); }
}

/* tabela generica (mantida para Estoque) */
.table,
.sales-table {
  margin-top: 6px;
}

.thead,
.trow {
  display: grid;
  gap: 12px;
  align-items: center;
}

.table .thead {
  grid-template-columns: 1.1fr 2fr 1.4fr 1.2fr 1.2fr;
}

.table .trow {
  grid-template-columns: 1.1fr 2fr 1.4fr 1.2fr 1.2fr;
  padding: 12px 0;
  border-bottom: 1px solid #f8fafc;
  font-size: 14px;
  color: #111827;
}

.thead {
  font-size: 12px;
  color: #6b7280;
  padding: 8px 0;
  border-bottom: 1px solid #f1f5f9;
}

.trow:last-child {
  border-bottom: none;
}

.empty {
  padding: 12px 0;
  font-size: 13px;
  color: #6b7280;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 12.5px;
  color: #111827;
}

.ellipsis {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.caps {
  text-transform: uppercase;
  font-size: 12px;
  color: #374151;
}
</style>
