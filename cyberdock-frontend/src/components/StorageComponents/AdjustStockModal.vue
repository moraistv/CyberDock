<template>
  <UniversalModal
    title="Ajustar Estoque"
    :is-open="isOpen"
    size="md"
    @close="$emit('close')"
  >
    <div v-if="sku" class="adj">
      <!-- Cabeçalho -->
      <div class="adj__header">
        <div class="sku-badge" :title="sku.descricao || ''">
          <span class="sku-badge__label">SKU</span>
          <span class="sku-badge__code">{{ sku.sku }}</span>
        </div>
        <div class="adj__hint" v-if="sku.descricao">{{ sku.descricao }}</div>
      </div>

      <!-- Form -->
      <form @submit.prevent="confirm" class="adj__form">
        <!-- Tipo (linha inteira) -->
        <div class="fg fg-full">
          <label class="lbl">Tipo de Movimentação</label>
          <div class="segmented" role="tablist" aria-label="Tipo de Movimentação">
            <button
              type="button"
              :class="['segmented__btn', { 'is-active': adjustmentData.movementType === 'entrada' }]"
              @click="adjustmentData.movementType = 'entrada'"
            >
              Entrada
            </button>
            <button
              type="button"
              :class="['segmented__btn', { 'is-active': adjustmentData.movementType === 'saida' }]"
              @click="adjustmentData.movementType = 'saida'"
            >
              Saída
            </button>
          </div>
        </div>

        <!-- Quantidade -->
        <div class="fg fg-full" :class="{ 'has-error': errors.quantityChange }">
          <label class="lbl" for="qty">Quantidade</label>
          <div class="stepper">
            <button type="button" class="stepper__btn" @click="decQty" aria-label="Diminuir">−</button>
            <input
              id="qty"
              ref="qtyInput"
              class="input stepper__input"
              type="number"
              min="1"
              step="1"
              v-model.number="adjustmentData.quantityChange"
              @focus="$event.target.select()"
            />
            <button type="button" class="stepper__btn" @click="incQty" aria-label="Aumentar">+</button>
          </div>
          <small v-if="errors.quantityChange" class="err">{{ errors.quantityChange }}</small>
        </div>

        <!-- Motivo -->
        <div class="fg fg-full" :class="{ 'has-error': errors.reason }">
          <label class="lbl" for="reason">Motivo</label>
          <textarea
            id="reason"
            class="input textarea"
            placeholder="Ex.: Contagem de inventário, avaria, transferência..."
            v-model.trim="adjustmentData.reason"
            rows="4"
          ></textarea>
          <small v-if="errors.reason" class="err">{{ errors.reason }}</small>
        </div>
      </form>

      <!-- Resumo -->
      <div class="adj__summary">
        <div class="summary__card">
          <div class="summary__row">
            <span class="summary__label">Tipo</span>
            <span class="summary__value" :class="adjustmentData.movementType === 'entrada' ? 'pos' : 'neg'">
              {{ adjustmentData.movementType === 'entrada' ? 'Entrada (+)' : 'Saída (–)' }}
            </span>
          </div>
          <div class="summary__row">
            <span class="summary__label">Quantidade</span>
            <span class="summary__value">{{ adjustmentData.quantityChange }}</span>
          </div>
          <div class="summary__row">
            <span class="summary__label">Motivo</span>
            <span class="summary__value">{{ adjustmentData.reason || '—' }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Rodapé -->
    <template #footer>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" @click="$emit('close')">Cancelar</button>
        <button type="button" class="btn btn-primary" :disabled="!isValid" @click="confirm">Confirmar</button>
      </div>
    </template>
  </UniversalModal>
</template>

<script>
import { defineComponent, reactive, ref, computed, watch, nextTick } from 'vue'
import UniversalModal from '../UniversalModal.vue'

export default defineComponent({
  name: 'AdjustStockModal',
  components: { UniversalModal },
  props: {
    isOpen: Boolean,
    sku: Object
  },
  emits: ['close', 'confirm'],
  setup(props, { emit }) {
    const qtyInput = ref(null)
    const adjustmentData = reactive({
      movementType: 'entrada',
      quantityChange: 1,
      reason: ''
    })

    const toast = (message, type = 'info', duration = 3200) => {
      window.dispatchEvent(new CustomEvent('show-toast', {
        detail: { id: `${type}-${Date.now()}-${Math.random().toString(36).slice(2,7)}`, message, type, duration }
      }))
    }

    watch(() => props.isOpen, async (open) => {
      if (open) {
        adjustmentData.movementType = 'entrada'
        adjustmentData.quantityChange = 1
        adjustmentData.reason = ''
        await nextTick()
        qtyInput.value?.focus?.()
      }
    }, { immediate: true })

    const errors = computed(() => {
      const e = {}
      if (!Number.isFinite(adjustmentData.quantityChange) || adjustmentData.quantityChange < 1) {
        e.quantityChange = 'Quantidade deve ser ≥ 1.'
      }
      if (!String(adjustmentData.reason || '').trim()) {
        e.reason = 'Informe um motivo.'
      }
      return e
    })
    const isValid = computed(() => Object.keys(errors.value).length === 0)

    const incQty = () => { adjustmentData.quantityChange = Math.max(1, Number(adjustmentData.quantityChange || 0) + 1) }
    const decQty = () => { adjustmentData.quantityChange = Math.max(1, Number(adjustmentData.quantityChange || 0) - 1) }

    const confirm = () => {
      if (!isValid.value) {
        // mostra o primeiro erro no toast
        const msg = errors.value.quantityChange || errors.value.reason || 'Preencha os campos obrigatórios.'
        toast(msg, 'error', 3500)
        return
      }
      const payload = {
        movementType: adjustmentData.movementType,
        quantityChange: Number(adjustmentData.quantityChange),
        reason: String(adjustmentData.reason).trim()
      }
      emit('confirm', payload)
    }

    return { adjustmentData, errors, isValid, incQty, decQty, confirm, qtyInput }
  }
})
</script>

<style scoped>
/* Evita overflow */
.adj, .adj * { box-sizing: border-box; }
.adj { display: grid; gap: 1rem; }
.adj__header { display: grid; gap: .4rem; }

/* Badge do SKU */
.sku-badge {
  display: inline-flex; align-items: center; gap: .5rem;
  background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 999px; padding: .35rem .6rem;
}
.sku-badge__label { font-size: .72rem; font-weight: 700; text-transform: uppercase; color: #334155; }
.sku-badge__code { font-weight: 700; }
.adj__hint { font-size: .84rem; color: #6b7280; }

/* Form */
.adj__form { display: grid; gap: .9rem; }
.fg { display: flex; flex-direction: column; }
.fg-full { grid-column: 1 / -1; }
.lbl { font-weight: 600; font-size: .875rem; margin-bottom: .45rem; }

.input {
  width: 100%; min-width: 0;
  padding: .62rem .8rem; border: 1px solid #d1d5db; border-radius: 10px;
  font-size: .92rem; background: #fff; color: #111827;
  outline: none; transition: border-color .15s, box-shadow .15s;
}
.input:focus { border-color: #93c5fd; box-shadow: 0 0 0 3px rgba(59,130,246,.18); }

.textarea { resize: none; min-height: 110px; }

/* Segmented */
.segmented {
  display: grid; grid-template-columns: 1fr 1fr; background: #f3f4f6;
  border: 1px solid #e5e7eb; border-radius: 10px; padding: .2rem;
}
.segmented__btn {
  background: transparent; border: 0; border-radius: 8px;
  padding: .5rem .75rem; font-weight: 600; color: #374151; cursor: pointer;
}
.segmented__btn.is-active { background: #2563eb; color: #fff; }

/* Stepper */
.stepper {
  display: grid; grid-template-columns: auto 1fr auto; align-items: stretch;
  border: 1px solid #d1d5db; border-radius: 10px; overflow: hidden;
}
.stepper__btn {
  width: 40px; background: #f3f4f6; border: 0; cursor: pointer; font-weight: 700;
  transition: background-color .15s;
}
.stepper__btn:hover { background: #e5e7eb; }
.stepper__input {
  border: 0; border-left: 1px solid #e5e7eb; border-right: 1px solid #e5e7eb;
  text-align: center; padding: .55rem .5rem; font-weight: 700;
}

/* Erros */
.has-error .input, .has-error .stepper { border-color: #ef4444; }
.err { color: #ef4444; font-size: .78rem; margin-top: .25rem; }

/* Resumo */
.adj__summary { margin-top: .25rem; }
.summary__card {
  border: 1px solid #e5e7eb; background: #fff; border-radius: 12px; padding: .75rem .9rem;
}
.summary__row { display: grid; grid-template-columns: auto 1fr; gap: .75rem; padding: .15rem 0; }
.summary__label { color: #6b7280; }
.summary__value { font-weight: 700; color: #111827; overflow-wrap: anywhere; }
.summary__value.pos { color: #16a34a; }
.summary__value.neg { color: #ef4444; }

/* Footer */
.modal-actions { display: flex; justify-content: flex-end; gap: .75rem; }
.btn {
  padding: .6rem 1.2rem; font-size: .875rem; font-weight: 600;
  border: none; border-radius: .5rem; cursor: pointer; transition: background-color .2s;
}
.btn-primary { background-color: #2563eb; color: #fff; }
.btn-primary:hover { background-color: #1d4ed8; }
.btn-secondary { background-color: #e5e7eb; color: #374151; }
.btn-secondary:hover { background-color: #d1d5db; }
.btn[disabled] { opacity: .6; cursor: not-allowed; }
</style>
