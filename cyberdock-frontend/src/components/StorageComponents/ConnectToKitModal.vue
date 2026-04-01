<template>
  <UniversalModal
    :title="`Conectar ${sku?.sku || 'SKU'} a Kits`"
    :is-open="isOpen"
    size="lg"
    @close="$emit('close')"
  >
    <div v-if="!sku || !sku.id" class="error-state">
      <div class="error-icon">⚠️</div>
      <p>Erro: SKU inválido ou não carregado.</p>
      <p class="error-details">Por favor, feche e tente novamente.</p>
    </div>
    
    <div v-else class="connect-kit-modal">
      <div class="sku-info">
        <div class="sku-header">
          <span class="sku-code">{{ sku?.sku }}</span>
          <span class="sku-stock">Estoque: {{ sku?.quantidade || 0 }}</span>
        </div>
        <p class="sku-description">{{ sku?.descricao }}</p>
      </div>

      <div class="kits-section">
        <h4>Selecione os kits para conectar:</h4>
        <p class="section-description">
          Escolha os kits onde este SKU será usado como componente e defina a quantidade necessária por kit.
        </p>

        <div v-if="availableKits.length === 0" class="no-kits">
          <div class="no-kits-icon"><svg  xmlns="http://www.w3.org/2000/svg"  width="24"  height="24"  viewBox="0 0 24 24"  fill="none"  stroke="currentColor"  stroke-width="2"  stroke-linecap="round"  stroke-linejoin="round"  class="icon icon-tabler icons-tabler-outline icon-tabler-packages"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M7 16.5l-5 -3l5 -3l5 3v5.5l-5 3z" /><path d="M2 13.5v5.5l5 3" /><path d="M7 16.545l5 -3.03" /><path d="M17 16.5l-5 -3l5 -3l5 3v5.5l-5 3z" /><path d="M12 19l5 3" /><path d="M17 16.5l5 -3" /><path d="M12 13.5v-5.5l-5 -3l5 -3l5 3v5.5" /><path d="M7 5.03v5.455" /><path d="M12 8l5 -3" /></svg></div>
          <p>Nenhum kit ativo disponível para conexão.</p>
          <button @click="$emit('create-kit')" class="btn btn-primary">
            Criar Primeiro Kit
          </button>
        </div>

        <div v-else class="kits-table-container">
          <table class="kits-table">
            <thead>
              <tr>
                <th class="select-col">
                  <input 
                    type="checkbox" 
                    :checked="selectedKitIds.length === availableKits.length && availableKits.length > 0"
                    :indeterminate="selectedKitIds.length > 0 && selectedKitIds.length < availableKits.length"
                    @change="toggleSelectAll"
                    class="select-all-checkbox"
                  >
                </th>
                <th class="kit-col">Kit</th>
                <th class="description-col">Descrição</th>
                <th class="components-col">Componentes</th>
                <th class="available-col">Disponível</th>
                <th class="quantity-col">Qtd. por Kit</th>
              </tr>
            </thead>
            <tbody>
              <tr 
                v-for="kit in availableKits" 
                :key="kit.id" 
                class="kit-row"
                :class="{ 'selected': selectedKitIds.includes(kit.id) }"
              >
                <td class="select-cell" data-label="Selecionar">
                  <input 
                    type="checkbox" 
                    :value="kit.id"
                    v-model="selectedKitIds"
                    class="kit-checkbox"
                  >
                </td>
                <td class="kit-cell" data-label="Kit">
                  <div class="kit-info">
                    <span class="kit-icon"><svg  xmlns="http://www.w3.org/2000/svg"  width="24"  height="24"  viewBox="0 0 24 24"  fill="none"  stroke="currentColor"  stroke-width="2"  stroke-linecap="round"  stroke-linejoin="round"  class="icon icon-tabler icons-tabler-outline icon-tabler-packages"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M7 16.5l-5 -3l5 -3l5 3v5.5l-5 3z" /><path d="M2 13.5v5.5l5 3" /><path d="M7 16.545l5 -3.03" /><path d="M17 16.5l-5 -3l5 -3l5 3v5.5l-5 3z" /><path d="M12 19l5 3" /><path d="M17 16.5l5 -3" /><path d="M12 13.5v-5.5l-5 -3l5 -3l5 3v5.5" /><path d="M7 5.03v5.455" /><path d="M12 8l5 -3" /></svg></span>
                    <span class="kit-sku">{{ kit.sku }}</span>
                  </div>
                </td>
                <td class="description-cell" data-label="Descrição">
                  <span class="kit-description">{{ kit.descricao }}</span>
                </td>
                <td class="components-cell" data-label="Componentes">
                  <span class="components-count">{{ (kit.kit_components || []).length }}</span>
                </td>
                <td class="available-cell" data-label="Disponível">
                  <span class="available-badge">{{ kit.available_kit_quantity || 0 }}</span>
                </td>
                <td class="quantity-cell" data-label="Qtd. por Kit">
                  <input 
                    v-if="selectedKitIds.includes(kit.id)"
                    type="number" 
                    :value="getQuantityForKit(kit.id)"
                    @input="setQuantityForKit(kit.id, $event.target.value)"
                    min="1" 
                    class="quantity-input"
                  >
                  <span v-else class="quantity-placeholder">-</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Resumo das conexões -->
      <div v-if="selectedKitIds.length > 0" class="connections-summary">
        <h4>📋 Resumo das Conexões</h4>
        <div class="summary-list">
          <div v-for="kitId in selectedKitIds" :key="kitId" class="summary-item">
            <span class="summary-kit">{{ getKitName(kitId) }}</span>
            <span class="summary-qty">{{ getQuantityForKit(kitId) }}x por kit</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Footer -->
    <template #footer>
      <div class="modal-actions">
        <button @click="$emit('close')" type="button" class="btn btn-secondary">
          Cancelar
        </button>
        <button 
          @click="handleConnect" 
          type="button" 
          class="btn btn-primary" 
          :disabled="!sku || !sku.id || selectedKitIds.length === 0 || isConnecting"
        >
          <SpinnerIcon v-if="isConnecting" />
          Conectar a{{ selectedKitIds.length > 1 ? 'os' : '' }} {{ selectedKitIds.length }} Kit(s)
        </button>
      </div>
    </template>
  </UniversalModal>
</template>

<script>
import { defineComponent, ref, watch } from 'vue'
import UniversalModal from '@/components/UniversalModal.vue'

const SpinnerIcon = defineComponent({
  name: 'SpinnerIcon',
  template: `<svg class="spinner" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 11-6.219-8.56"/></svg>`
})

export default defineComponent({
  name: 'ConnectToKitModal',
  components: { UniversalModal, SpinnerIcon },
  props: {
    isOpen: { type: Boolean, required: true },
    sku: { type: Object, default: null },
    availableKits: { type: Array, default: () => [] },
    isConnecting: { type: Boolean, default: false }
  },
  emits: ['close', 'connect', 'create-kit'],
  setup(props, { emit }) {
    const selectedKitIds = ref([])
    const kitQuantities = ref({})

    const getQuantityForKit = (kitId) => {
      return kitQuantities.value[kitId] || 1
    }

    const setQuantityForKit = (kitId, quantity) => {
      kitQuantities.value[kitId] = Math.max(1, Number(quantity) || 1)
    }

    const getKitName = (kitId) => {
      const kit = props.availableKits.find(k => k.id === kitId)
      return kit ? `${kit.sku}` : 'Kit não encontrado'
    }

    const toggleSelectAll = (event) => {
      if (event.target.checked) {
        selectedKitIds.value = props.availableKits.map(kit => kit.id)
        props.availableKits.forEach(kit => {
          if (!kitQuantities.value[kit.id]) {
            kitQuantities.value[kit.id] = 1
          }
        })
      } else {
        selectedKitIds.value = []
        kitQuantities.value = {}
      }
    }

    // CORREÇÃO: Lógica mais robusta para lidar com o ID do SKU.
    const handleConnect = () => {
      // Validação de segurança para garantir que o SKU e seu ID existem.
      if (!props.sku || !props.sku.id) {
        console.error('handleConnect: Tentativa de conectar com SKU inválido:', props.sku);
        // Pode emitir um evento de erro ou mostrar uma notificação se desejar.
        return;
      }
      
      if (selectedKitIds.value.length === 0) {
        console.warn('handleConnect: Nenhum kit selecionado.');
        return;
      }
      
      const connections = selectedKitIds.value.map(kitId => ({
        kit_id: kitId,
        quantity_per_kit: getQuantityForKit(kitId)
      }));
      
      const payload = {
        sku_id: props.sku.id, // Usa o ID do SKU passado via prop.
        connections
      };

      emit('connect', payload);
    }

    // Reset do estado local quando o modal abre ou fecha
    watch(() => props.isOpen, (isOpen) => {
      if (isOpen) {
        // Quando abrir, limpa seleções anteriores.
        selectedKitIds.value = []
        kitQuantities.value = {}
      }
    })

    return {
      selectedKitIds,
      kitQuantities,
      getQuantityForKit,
      setQuantityForKit,
      getKitName,
      toggleSelectAll,
      handleConnect
    }
  }
})
</script>

<style scoped>
.connect-kit-modal {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.error-state {
  text-align: center;
  padding: 2rem;
  color: #b91c1c;
}
.error-icon {
  font-size: 3rem;
  margin-bottom: 1rem;
}
.error-details {
  font-size: 0.8rem;
  color: #9ca3af;
  margin-top: 1rem;
}

.sku-info {
  padding: 1rem;
  background: linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%);
  border: 1px solid #0ea5e9;
  border-radius: 0.75rem;
}

.sku-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.5rem;
}

.sku-code {
  font-family: ui-monospace, 'Courier New', monospace;
  font-weight: 600;
  color: #0f172a;
  background: rgba(255, 255, 255, 0.8);
  padding: 0.25rem 0.5rem;
  border-radius: 0.375rem;
}

.sku-stock {
  font-size: 0.875rem;
  color: #059669;
  background: #d1fae5;
  padding: 0.25rem 0.5rem;
  border-radius: 0.375rem;
  font-weight: 500;
}

.sku-description {
  margin: 0;
  color: #374151;
  font-size: 0.875rem;
}

.kits-section h4 {
  margin: 0 0 0.5rem 0;
  color: #111827;
  font-size: 1.125rem;
  font-weight: 600;
}

.section-description {
  margin: 0 0 1rem 0;
  color: #6b7280;
  font-size: 0.875rem;
  line-height: 1.5;
}

.no-kits {
  text-align: center;
  padding: 2rem;
  color: #6b7280;
}

.no-kits-icon {
  font-size: 3rem;
  margin-bottom: 1rem;
}

/* Tabela de Kits */
.kits-table-container {
  max-height: 400px;
  overflow-y: auto;
  border: 1px solid #e5e7eb;
  border-radius: 0.75rem;
  background: white;
}

.kits-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.875rem;
}

.kits-table thead {
  background: #f8fafc;
  border-bottom: 2px solid #e5e7eb;
  position: sticky;
  top: 0;
  z-index: 10;
}

.kits-table th {
  padding: 0.875rem 1rem;
  text-align: left;
  font-weight: 600;
  color: #374151;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  border-bottom: 1px solid #e5e7eb;
}

.kits-table td {
  padding: 1rem;
  border-bottom: 1px solid #f3f4f6;
  vertical-align: middle;
}

.kit-row {
  transition: all 0.2s ease;
}

.kit-row:hover {
  background: #f8fafc;
}

.kit-row.selected {
  background: #eff6ff;
  border-left: 3px solid #3b82f6;
}

.kit-row.selected:hover {
  background: #dbeafe;
}

/* Colunas específicas */
.select-col { width: 50px; text-align: center; }
.kit-col { width: 120px; }
.description-col { min-width: 200px; }
.components-col { width: 100px; text-align: center; }
.available-col { width: 90px; text-align: center; }
.quantity-col { width: 120px; text-align: center; }

/* Células específicas */
.select-cell { text-align: center; }
.kit-checkbox,
.select-all-checkbox {
  width: 16px;
  height: 16px;
  cursor: pointer;
}

.kit-info { display: flex; align-items: center; gap: 0.5rem; }
.kit-icon { font-size: 1.1rem; }
.kit-sku { font-family: ui-monospace, 'Courier New', monospace; font-weight: 600; color: #111827; }
.kit-description { color: #6b7280; line-height: 1.4; }

.components-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 24px;
  height: 24px;
  background: #f3f4f6;
  color: #6b7280;
  border-radius: 50%;
  font-size: 0.75rem;
  font-weight: 500;
}

.available-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 32px;
  height: 24px;
  background: #d1fae5;
  color: #059669;
  border-radius: 0.375rem;
  font-size: 0.75rem;
  font-weight: 600;
  padding: 0 0.5rem;
}

.quantity-input {
  width: 70px;
  padding: 0.5rem;
  border: 1px solid #d1d5db;
  border-radius: 0.375rem;
  text-align: center;
  font-size: 0.875rem;
  background: white;
}
.quantity-input:focus {
  outline: none;
  border-color: #3b82f6;
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
}
.quantity-placeholder { color: #9ca3af; font-style: italic; }

.connections-summary {
  padding: 1rem;
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 0.75rem;
}
.connections-summary h4 {
  margin: 0 0 0.75rem 0;
  color: #111827;
  font-size: 1rem;
  font-weight: 600;
}
.summary-list { display: flex; flex-direction: column; gap: 0.5rem; }
.summary-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.5rem;
  background: white;
  border-radius: 0.375rem;
  border: 1px solid #e5e7eb;
}
.summary-kit { color: #374151; font-size: 0.875rem; }
.summary-qty { font-weight: 600; color: #0ea5e9; font-size: 0.875rem; }

/* Footer e Botões */
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
  padding-top: 1rem;
  border-top: 1px solid #e5e7eb;
}
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 0.625rem 1rem;
  border: none;
  border-radius: 0.5rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
  min-height: 42px;
}
.btn:disabled { opacity: 0.6; cursor: not-allowed; }
.btn-primary { background: #6366f1; color: white; }
.btn-primary:hover:not(:disabled) { background: #4f46e5; }
.btn-secondary { background: white; color: #374151; border: 1px solid #d1d5db; }
.btn-secondary:hover:not(:disabled) { background: #f9fafb; }

@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.spinner { animation: spin 1s linear infinite; }

/* Responsividade da Tabela */
@media (max-width: 768px) {
  .kits-table-container { max-height: 300px; }
  .kits-table, .kits-table thead, .kits-table tbody, .kits-table th, .kits-table td, .kits-table tr { display: block; }
  .kits-table thead tr { position: absolute; top: -9999px; left: -9999px; }
  .kits-table tr { border: 1px solid #e5e7eb; margin-bottom: 0.5rem; border-radius: 0.5rem; background: white; padding: 0.75rem; }
  .kits-table tr.selected { border-color: #3b82f6; background: #eff6ff; }
  .kits-table td { border: none; position: relative; padding: 0.5rem 0; display: flex; justify-content: space-between; align-items: center; }
  .kits-table td::before { content: attr(data-label); font-weight: 600; color: #374151; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; min-width: 100px; }
  .select-cell, .kit-cell, .description-cell, .components-cell, .available-cell, .quantity-cell {
    padding-left: 0;
    padding-right: 0;
  }
  .quantity-input { width: 80px; }
  .summary-item { flex-direction: column; align-items: stretch; gap: 0.25rem; }
}
</style>
