<template>
  <UniversalModal
    :title="`Histórico do SKU: ${sku?.sku || '—'}`"
    :is-open="isOpen"
    @close="$emit('close')"
    size="large"
  >
    <div class="history">
      <!-- Top bar: filtros -->
      <div class="history__toolbar">
        <div class="segmented" role="tablist" aria-label="Filtro de tipo">
          <button type="button" :class="['segmented__btn', { 'is-active': typeFilter === 'all' }]" @click="typeFilter = 'all'">Todos</button>
          <button type="button" :class="['segmented__btn', { 'is-active': typeFilter === 'entrada' }]" @click="typeFilter = 'entrada'">Entrada</button>
          <button type="button" :class="['segmented__btn', { 'is-active': typeFilter === 'saida' }]" @click="typeFilter = 'saida'">Saída</button>
        </div>

        <div class="search">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 21l-4.3-4.3M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15z"/></svg>
          <input class="search__input" type="text" v-model.trim="query" placeholder="Buscar por motivo..." />
        </div>
      </div>

      <!-- Conteúdo -->
      <div v-if="isLoading" class="feedback">Carregando histórico…</div>
      <div v-else-if="filtered.length === 0" class="feedback">
        <div class="empty">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h10"/></svg>
          <p>Nenhuma movimentação encontrada.</p>
        </div>
      </div>
      <div v-else class="table-wrap">
        <table class="tbl">
          <thead class="tbl__head">
            <tr>
              <th>Data</th>
              <th>Tipo</th>
              <th class="th-right">Quantidade</th>
              <th>Motivo</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in filtered" :key="m.id">
              <td class="td-date">
                <div class="date-main">{{ formatDate(m.created_at) }}</div>
                <div class="date-sub">{{ formatTime(m.created_at) }}</div>
              </td>
              <td>
                <span :class="['chip', m.movement_type]">{{ m.movement_type }}</span>
              </td>
              <td class="td-right" :class="m.movement_type">
                {{ m.movement_type === 'entrada' ? '+' : '-' }}{{ m.quantity_change }}
              </td>
              <td class="td-reason">{{ m.reason || '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </UniversalModal>
</template>

<script>
import { defineComponent, ref, computed } from 'vue';
import UniversalModal from '../UniversalModal.vue';

export default defineComponent({
  name: 'SkuHistoryModal',
  components: { UniversalModal },
  props: {
    isOpen: Boolean,
    sku: Object,
    movements: Array,
    isLoading: Boolean,
  },
  emits: ['close'],
  setup(props) {
    const typeFilter = ref('all'); // all | entrada | saida
    const query = ref('');

    const filtered = computed(() => {
      const list = Array.isArray(props.movements) ? props.movements : [];
      const byType = typeFilter.value === 'all'
        ? list
        : list.filter(m => m.movement_type === typeFilter.value);
      const q = query.value.toLowerCase();
      if (!q) return byType;
      return byType.filter(m => String(m.reason || '').toLowerCase().includes(q));
    });

    const formatDate = (s) => {
      const d = new Date(s);
      return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    };
    const formatTime = (s) => {
      const d = new Date(s);
      return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    };

    return { typeFilter, query, filtered, formatDate, formatTime };
  }
});
</script>

<style scoped>
.history { display: grid; gap: 0.75rem; }
.history__toolbar {
  display: grid; grid-template-columns: auto 1fr; gap: 0.75rem; align-items: center;
  position: sticky; top: 0; background: #fff; z-index: 1; padding-top: .25rem;
}

/* Segmented minimal */
.segmented {
  display: grid; grid-auto-flow: column; gap: .25rem; background: #f3f4f6;
  border: 1px solid #e5e7eb; border-radius: 999px; padding: .22rem;
}
.segmented__btn {
  background: transparent; border: 0; border-radius: 999px;
  padding: .35rem .75rem; font-weight: 600; font-size: .86rem; color: #374151; cursor: pointer;
}
.segmented__btn.is-active { background: #111827; color: #fff; }

/* Search */
.search {
  display: grid; grid-template-columns: auto 1fr; align-items: center; gap: .4rem;
  border: 1px solid #e5e7eb; border-radius: 10px; padding: .35rem .55rem; background: #fff;
}
.search svg { width: 18px; height: 18px; stroke: #6b7280; stroke-width: 2; fill: none; }
.search__input {
  border: 0; outline: none; font-size: .9rem; color: #111827; width: 100%;
}

/* Tabela */
.table-wrap { max-height: 60vh; overflow: auto; border: 1px solid #e5e7eb; border-radius: 12px; }
.tbl { width: 100%; border-collapse: collapse; background: #fff; }
.tbl__head { position: sticky; top: 0; background: #fff; z-index: 1; }
.tbl th, .tbl td { padding: .7rem .9rem; border-bottom: 1px solid #eef2f7; vertical-align: top; }
.th-right, .td-right { text-align: right; }

.td-date .date-main { font-weight: 700; color: #111827; }
.td-date .date-sub  { font-size: .78rem; color: #6b7280; }

.chip {
  display: inline-flex; align-items: center; gap: .35rem;
  padding: .18rem .55rem; border-radius: 999px; font-size: .78rem; font-weight: 700; text-transform: capitalize; color: #fff;
}
.chip.entrada { background: #16a34a; }
.chip.saida   { background: #dc2626; }

.td-right.entrada { color: #16a34a; font-weight: 700; }
.td-right.saida   { color: #dc2626; font-weight: 700; }

/* Estados */
.feedback { text-align: center; color: #6b7280; padding: 2.2rem 1rem; }
.empty {
  display: grid; place-items: center; gap: .4rem;
  color: #6b7280;
}
.empty svg { width: 36px; height: 36px; stroke: currentColor; stroke-width: 2; fill: none; opacity: .6; }
</style>
