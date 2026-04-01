<template>
  <UniversalModal
    title="Ajustar Estoque de Componente"
    :is-open="isOpen"
    size="lg"
    @close="$emit('close')"
  >
    <div v-if="sku" class="component-adj">
      <!-- Cabeçalho do SKU -->
      <div class="component-adj__header">
        <div class="sku-badge" :title="sku.descricao || ''">
          <span class="sku-badge__label">SKU Componente</span>
          <span class="sku-badge__code">{{ sku.sku }}</span>
        </div>
        <div class="component-adj__hint" v-if="sku.descricao">{{ sku.descricao }}</div>
        <div class="current-stock">
          <span class="stock-label">Estoque Atual:</span>
          <span class="stock-value">{{ sku.quantidade }} unidades</span>
        </div>
      </div>

      <!-- Alertas de Kits -->
      <div v-if="sku.used_in_kits && sku.used_in_kits.length > 0" class="kit-warning">
        <div class="warning-icon">⚠️</div>
        <div class="warning-content">
          <h4>Este componente é usado em kits:</h4>
          <div class="kit-list">
            <span 
              v-for="kit in sku.used_in_kits" 
              :key="kit.kit_sku_code"
              class="kit-badge"
            >
              {{ kit.kit_sku_code }} ({{ kit.quantity_per_kit }}x)
            </span>
          </div>
          <p class="warning-text">
            Alterações no estoque afetarão a disponibilidade dos kits acima.
          </p>
        </div>
      </div>

      <!-- Form de Ajuste -->
      <form @submit.prevent="confirm" class="component-adj__form">
        <!-- Tipo de Movimentação -->
        <div class="fg fg-full">
          <label class="lbl">Tipo de Movimentação</label>
          <div class="segmented" role="tablist" aria-label="Tipo de Movimentação">
            <button
              type="button"
              :class="['segmented__btn', { 'is-active': adjustmentData.movementType === 'entrada' }]"
              @click="adjustmentData.movementType = 'entrada'"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 5v14M5 12h14"/>
              </svg>
              Adicionar Estoque
            </button>
            <button
              type="button"
              :class="['segmented__btn', { 'is-active': adjustmentData.movementType === 'saida' }]"
              @click="adjustmentData.movementType = 'saida'"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M5 12h14"/>
              </svg>
              Remover Estoque
            </button>
          </div>
        </div>

        <!-- Quantidade -->
        <div class="fg fg-half" :class="{ 'has-error': errors.quantityChange }">
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

        <!-- Previsão do Novo Estoque -->
        <div class="fg fg-half">
          <label class="lbl">Novo Estoque</label>
          <div class="new-stock-preview">
            <span class="current">{{ sku.quantidade }}</span>
            <span class="operator">{{ adjustmentData.movementType === 'entrada' ? '+' : '−' }}</span>
            <span class="change">{{ adjustmentData.quantityChange }}</span>
            <span class="equals">=</span>
            <span 
              class="result" 
              :class="{ 
                'positive': newStock > sku.quantidade, 
                'negative': newStock < sku.quantidade,
                'warning': newStock < 0 
              }"
            >
              {{ newStock }}
            </span>
          </div>
          <small v-if="newStock < 0" class="err">Estoque não pode ficar negativo</small>
        </div>

        <!-- Motivo -->
        <div class="fg fg-full" :class="{ 'has-error': errors.reason }">
          <label class="lbl" for="reason">Motivo da Movimentação</label>
          <textarea
            id="reason"
            class="input textarea"
            placeholder="Ex.: Recebimento de mercadoria, correção de inventário, defeito/avaria..."
            v-model.trim="adjustmentData.reason"
            rows="3"
          ></textarea>
          <small v-if="errors.reason" class="err">{{ errors.reason }}</small>
        </div>
      </form>

      <!-- Resumo da Operação -->
      <div class="component-adj__summary">
        <div class="summary__card">
          <h4 class="summary__title">Resumo da Operação</h4>
          <div class="summary__row">
            <span class="summary__label">Componente</span>
            <span class="summary__value">{{ sku.sku }} - {{ sku.descricao }}</span>
          </div>
          <div class="summary__row">
            <span class="summary__label">Operação</span>
            <span class="summary__value" :class="adjustmentData.movementType === 'entrada' ? 'pos' : 'neg'">
              {{ adjustmentData.movementType === 'entrada' ? 'Adicionar (+)' : 'Remover (−)' }}
            </span>
          </div>
          <div class="summary__row">
            <span class="summary__label">Quantidade</span>
            <span class="summary__value">{{ adjustmentData.quantityChange }} unidades</span>
          </div>
          <div class="summary__row">
            <span class="summary__label">Estoque Final</span>
            <span class="summary__value" :class="{ 'warning': newStock < 0 }">{{ newStock }} unidades</span>
          </div>
          <div class="summary__row">
            <span class="summary__label">Motivo</span>
            <span class="summary__value">{{ adjustmentData.reason || '—' }}</span>
          </div>
        </div>
      </div>

      <!-- Impacto nos Kits -->
      <div v-if="sku.used_in_kits && sku.used_in_kits.length > 0" class="kit-impact">
        <h4 class="impact-title">Impacto nos Kits</h4>
        <div class="impact-list">
          <div 
            v-for="kit in sku.used_in_kits" 
            :key="kit.kit_sku_code"
            class="impact-item"
          >
            <div class="impact-kit">
              <span class="kit-name">{{ kit.kit_sku_code }}</span>
              <span class="kit-usage">Usa {{ kit.quantity_per_kit }}x deste componente</span>
            </div>
            <div class="impact-calculation">
              <span class="available-kits">
                {{ Math.floor(newStock / kit.quantity_per_kit) }} kits disponíveis
              </span>
              <span 
                v-if="Math.floor(newStock / kit.quantity_per_kit) < Math.floor(sku.quantidade / kit.quantity_per_kit)" 
                class="impact-warning"
              >
                ({{ Math.floor(sku.quantidade / kit.quantity_per_kit) - Math.floor(newStock / kit.quantity_per_kit) }} kits a menos)
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Rodapé -->
    <template #footer>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" @click="$emit('close')">
          Cancelar
        </button>
        <button 
          type="button" 
          class="btn btn-primary" 
          :disabled="!isValid || newStock < 0" 
          @click="confirm"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M20 6L9 17l-5-5"/>
          </svg>
          Confirmar Ajuste
        </button>
      </div>
    </template>
  </UniversalModal>
</template>

<script>
import { defineComponent, reactive, ref, computed, watch, nextTick } from 'vue'
import UniversalModal from '../UniversalModal.vue'

export default defineComponent({
  name: 'ComponentStockAdjustModal',
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

    const newStock = computed(() => {
      if (!props.sku) return 0
      const currentStock = props.sku.quantidade || 0
      const change = adjustmentData.quantityChange || 0
      return adjustmentData.movementType === 'entrada' 
        ? currentStock + change 
        : currentStock - change
    })

    const errors = computed(() => {
      const e = {}
      if (!Number.isFinite(adjustmentData.quantityChange) || adjustmentData.quantityChange < 1) {
        e.quantityChange = 'Quantidade deve ser ≥ 1.'
      }
      if (!String(adjustmentData.reason || '').trim()) {
        e.reason = 'Informe um motivo para a movimentação.'
      }
      return e
    })

    const isValid = computed(() => Object.keys(errors.value).length === 0)

    const incQty = () => { 
      adjustmentData.quantityChange = Math.max(1, Number(adjustmentData.quantityChange || 0) + 1) 
    }
    
    const decQty = () => { 
      adjustmentData.quantityChange = Math.max(1, Number(adjustmentData.quantityChange || 0) - 1) 
    }

    const confirm = () => {
      if (!isValid.value) {
        const msg = errors.value.quantityChange || errors.value.reason || 'Preencha os campos obrigatórios.'
        toast(msg, 'error', 3500)
        return
      }

      if (newStock.value < 0) {
        toast('O estoque não pode ficar negativo.', 'error', 3500)
        return
      }

      const payload = {
        movementType: adjustmentData.movementType,
        quantityChange: Number(adjustmentData.quantityChange),
        reason: String(adjustmentData.reason).trim(),
        newStock: newStock.value
      }
      
      emit('confirm', payload)
    }

    return { 
      adjustmentData, 
      errors, 
      isValid, 
      newStock,
      incQty, 
      decQty, 
      confirm, 
      qtyInput 
    }
  }
})
</script>

<style scoped>
/* Base */
.component-adj, .component-adj * { box-sizing: border-box; }
.component-adj { display: grid; gap: 1.5rem; }

/* Header */
.component-adj__header { 
  display: grid; 
  gap: .5rem; 
  padding: 1rem;
  background: linear-gradient(135deg, #f8fafc 0%, #e2e8f0 100%);
  border-radius: 12px;
  border: 1px solid #e2e8f0;
}

.sku-badge {
  display: inline-flex; 
  align-items: center; 
  gap: .5rem;
  background: #3b82f6; 
  color: white;
  border-radius: 999px; 
  padding: .4rem .8rem;
  width: fit-content;
}

.sku-badge__label { 
  font-size: .75rem; 
  font-weight: 700; 
  text-transform: uppercase; 
}

.sku-badge__code { 
  font-weight: 700; 
  font-family: ui-monospace, 'Courier New', monospace;
}

.component-adj__hint { 
  font-size: .9rem; 
  color: #64748b; 
  font-weight: 500;
}

.current-stock {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  background: #f1f5f9;
  border-radius: 8px;
  width: fit-content;
}

.stock-label {
  font-size: 0.875rem;
  color: #64748b;
  font-weight: 500;
}

.stock-value {
  font-size: 0.875rem;
  color: #0f172a;
  font-weight: 700;
}

/* Kit Warning */
.kit-warning {
  display: flex;
  gap: 1rem;
  padding: 1rem;
  background: #fef3c7;
  border: 1px solid #f59e0b;
  border-radius: 12px;
  align-items: flex-start;
}

.warning-icon {
  font-size: 1.5rem;
  flex-shrink: 0;
}

.warning-content h4 {
  margin: 0 0 0.5rem 0;
  color: #92400e;
  font-size: 0.875rem;
  font-weight: 600;
}

.kit-list {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
}

.kit-badge {
  background: #f59e0b;
  color: white;
  padding: 0.25rem 0.5rem;
  border-radius: 6px;
  font-size: 0.75rem;
  font-weight: 600;
  font-family: ui-monospace, 'Courier New', monospace;
}

.warning-text {
  margin: 0;
  color: #92400e;
  font-size: 0.875rem;
}

/* Form */
.component-adj__form { 
  display: grid; 
  grid-template-columns: 1fr 1fr;
  gap: 1rem; 
}

.fg { display: flex; flex-direction: column; }
.fg-full { grid-column: 1 / -1; }
.fg-half { grid-column: span 1; }

.lbl { 
  font-weight: 600; 
  font-size: .875rem; 
  margin-bottom: .5rem; 
  color: #374151;
}

.input {
  width: 100%; 
  min-width: 0;
  padding: .65rem .8rem; 
  border: 1px solid #d1d5db; 
  border-radius: 10px;
  font-size: .9rem; 
  background: #fff; 
  color: #111827;
  outline: none; 
  transition: border-color .15s, box-shadow .15s;
}

.input:focus { 
  border-color: #3b82f6; 
  box-shadow: 0 0 0 3px rgba(59,130,246,.1); 
}

.textarea { 
  resize: none; 
  min-height: 80px; 
}

/* Segmented Control */
.segmented {
  display: grid; 
  grid-template-columns: 1fr 1fr; 
  background: #f3f4f6;
  border: 1px solid #e5e7eb; 
  border-radius: 10px; 
  padding: .2rem;
}

.segmented__btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  background: transparent; 
  border: 0; 
  border-radius: 8px;
  padding: .6rem .75rem; 
  font-weight: 600; 
  color: #374151; 
  cursor: pointer;
  transition: all 0.2s;
}

.segmented__btn.is-active { 
  background: #3b82f6; 
  color: #fff; 
}

/* Stepper */
.stepper {
  display: grid; 
  grid-template-columns: auto 1fr auto; 
  align-items: stretch;
  border: 1px solid #d1d5db; 
  border-radius: 10px; 
  overflow: hidden;
}

.stepper__btn {
  width: 40px; 
  background: #f3f4f6; 
  border: 0; 
  cursor: pointer; 
  font-weight: 700;
  transition: background-color .15s;
}

.stepper__btn:hover { background: #e5e7eb; }

.stepper__input {
  border: 0; 
  border-left: 1px solid #e5e7eb; 
  border-right: 1px solid #e5e7eb;
  text-align: center; 
  padding: .6rem .5rem; 
  font-weight: 700;
}

/* New Stock Preview */
.new-stock-preview {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  font-family: ui-monospace, 'Courier New', monospace;
  font-weight: 600;
}

.current { color: #64748b; }
.operator { color: #3b82f6; font-size: 1.1rem; }
.change { color: #0f172a; }
.equals { color: #64748b; }
.result { font-size: 1.1rem; }
.result.positive { color: #059669; }
.result.negative { color: #dc2626; }
.result.warning { color: #dc2626; font-weight: 700; }

/* Summary */
.component-adj__summary {
  padding: 1rem;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
}

.summary__card { display: grid; gap: .75rem; }

.summary__title {
  margin: 0 0 0.5rem 0;
  color: #374151;
  font-size: 1rem;
  font-weight: 600;
}

.summary__row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.5rem 0;
  border-bottom: 1px solid #e5e7eb;
}

.summary__row:last-child {
  border-bottom: none;
}

.summary__label { 
  font-size: .875rem;
  color: #6b7280; 
  font-weight: 500;
}

.summary__value { 
  font-weight: 600; 
  color: #111827;
  text-align: right;
}

.summary__value.pos { color: #059669; }
.summary__value.neg { color: #dc2626; }
.summary__value.warning { color: #dc2626; }

/* Kit Impact */
.kit-impact {
  padding: 1rem;
  background: #fef7ff;
  border: 1px solid #e879f9;
  border-radius: 12px;
}

.impact-title {
  margin: 0 0 1rem 0;
  color: #86198f;
  font-size: 1rem;
  font-weight: 600;
}

.impact-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.impact-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.75rem;
  background: white;
  border: 1px solid #e879f9;
  border-radius: 8px;
}

.impact-kit {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.kit-name {
  font-weight: 700;
  color: #86198f;
  font-family: ui-monospace, 'Courier New', monospace;
}

.kit-usage {
  font-size: 0.875rem;
  color: #6b7280;
}

.impact-calculation {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 0.25rem;
}

.available-kits {
  font-weight: 600;
  color: #059669;
}

.impact-warning {
  font-size: 0.875rem;
  color: #dc2626;
  font-weight: 500;
}

/* Errors */
.has-error .input, 
.has-error .stepper { 
  border-color: #ef4444; 
}

.err { 
  color: #ef4444; 
  font-size: .8rem; 
  margin-top: .3rem; 
  font-weight: 500;
}

/* Buttons */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 1.5rem;
  border: none;
  border-radius: 10px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
  text-decoration: none;
}

.btn-secondary {
  background: #f3f4f6;
  color: #374151;
  border: 1px solid #d1d5db;
}

.btn-secondary:hover:not(:disabled) {
  background: #e5e7eb;
}

.btn-primary {
  background: #3b82f6;
  color: white;
}

.btn-primary:hover:not(:disabled) {
  background: #2563eb;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
  padding-top: 1rem;
  border-top: 1px solid #e5e7eb;
}

/* Responsive */
@media (max-width: 768px) {
  .component-adj__form {
    grid-template-columns: 1fr;
  }
  
  .fg-half {
    grid-column: 1 / -1;
  }
  
  .impact-item {
    flex-direction: column;
    align-items: flex-start;
    gap: 0.5rem;
  }
  
  .impact-calculation {
    align-items: flex-start;
  }
  
  .new-stock-preview {
    justify-content: center;
    flex-wrap: wrap;
  }
}
</style>
