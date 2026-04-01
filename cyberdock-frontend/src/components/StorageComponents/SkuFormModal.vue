<template>
  <UniversalModal
    :title="isEditing ? 'Editar Informações do SKU' : 'Adicionar Novo SKU'"
    :is-open="isOpen"
    size="xl"
    @close="$emit('close')"
  >
    <form @submit.prevent="handleSave" class="sku-form">
      <!-- SKU -->
      <div class="form-group" :class="{ 'has-error': errors.sku }">
        <label for="sku-code">Código SKU</label>
        <input id="sku-code" type="text" v-model="editableSku.sku" :disabled="isEditing" required>
        <small v-if="errors.sku" class="err">{{ errors.sku }}</small>
      </div>

      <!-- Descrição -->
      <div class="form-group" :class="{ 'has-error': errors.descricao }">
        <label for="sku-description">Descrição do Produto</label>
        <textarea id="sku-description" v-model="editableSku.descricao" rows="3" required></textarea>
        <small v-if="errors.descricao" class="err">{{ errors.descricao }}</small>
      </div>

      <!-- Conectar SKU a Kits Existentes -->
      <div v-if="debugActiveKits.length > 0 && !isEditing" class="kit-connection-section">
        <h4 style="margin:0.5rem 0 1rem 0; display: flex; align-items: center; gap: 0.5rem;"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon icon-tabler icons-tabler-outline icon-tabler-link"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M9 15l6 -6" /><path d="M11 6l.463 -.536a5 5 0 0 1 7.071 7.072l-.534 .464" /><path d="M13 18l-.397 .534a5.068 5.068 0 0 1 -7.127 0a4.972 4.972 0 0 1 0 -7.071l.524 -.463" /></svg> Conectar a Kits Existentes</h4>
        <p style="margin:0 0 1rem 0; color:#6b7280; font-size:0.875rem;">
          Selecione os kits onde este SKU deve ser adicionado como componente:
        </p>
        
        <div class="kits-selection-table-container">
          <table class="kits-selection-table">
            <thead>
              <tr>
                <th class="select-col">
                  <input 
                    type="checkbox" 
                    :checked="selectedKitsForConnection.length === debugActiveKits.length && debugActiveKits.length > 0"
                    :indeterminate="selectedKitsForConnection.length > 0 && selectedKitsForConnection.length < debugActiveKits.length"
                    @change="toggleSelectAllKits"
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
                v-for="kit in debugActiveKits" 
                :key="kit.id" 
                class="kit-selection-row"
                :class="{ 'selected': selectedKitsForConnection.includes(kit.id) }"
              >
                <td class="select-cell" data-label="Selecionar">
                  <input 
                    type="checkbox" 
                    :value="kit.id"
                    v-model="selectedKitsForConnection"
                    class="kit-checkbox"
                  >
                </td>
                <td class="kit-cell" data-label="Kit">
                  <div class="kit-info">
                    <span class="kit-icon"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon icon-tabler icons-tabler-outline icon-tabler-packages"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M7 16.5l-5 -3l5 -3l5 3v5.5l-5 3z" /><path d="M2 13.5v5.5l5 3" /><path d="M7 16.545l5 -3.03" /><path d="M17 16.5l-5 -3l5 -3l5 3v5.5l-5 3z" /><path d="M12 19l5 3" /><path d="M17 16.5l5 -3" /><path d="M12 13.5v-5.5l-5 -3l5 -3l5 3v5.5" /><path d="M7 5.03v5.455" /><path d="M12 8l5 -3" /></svg></span>
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
                  <span class="available-badge">{{ kit.available_quantity || 0 }}</span>
                </td>
                <td class="quantity-cell" data-label="Qtd. por Kit">
                  <input 
                    v-if="selectedKitsForConnection.includes(kit.id)"
                    type="number" 
                    :value="getQuantityForKit(kit.id)"
                    @input="setQuantityForKit(kit.id, $event.target.value)"
                    min="1" 
                    class="quantity-input"
                    placeholder="1"
                  >
                  <span v-else class="quantity-placeholder">-</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        
        <div v-if="selectedKitsForConnection.length > 0" class="connection-summary">
          <div class="summary-header">
            <span class="summary-icon">🎯</span>
            <strong>Resumo das Conexões</strong>
          </div>
          <div class="summary-items">
            <div v-for="kitId in selectedKitsForConnection" :key="kitId" class="summary-item">
              <span>{{ getKitName(kitId) }}</span>
              <span class="summary-quantity">{{ getQuantityForKit(kitId) }}x por kit</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Lista de Kits Onde Este SKU Já É Componente (para edição) -->
      <div v-if="isEditing && skuKitConnections.length > 0" class="existing-connections-section">
        <h4 style="margin:0.5rem 0 1rem 0; display: flex; align-items: center; gap: 0.5rem;"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon icon-tabler icons-tabler-outline icon-tabler-link"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M9 15l6 -6" /><path d="M11 6l.463 -.536a5 5 0 0 1 7.071 7.072l-.534 .464" /><path d="M13 18l-.397 .534a5.068 5.068 0 0 1 -7.127 0a4.972 4.972 0 0 1 0 -7.071l.524 -.463" /></svg> Kits Conectados</h4>
        <div class="existing-connections-list">
          <div v-for="connection in skuKitConnections" :key="connection.kit_id" class="connection-item">
            <div class="connection-info">
              <strong><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon icon-tabler icons-tabler-outline icon-tabler-packages"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M7 16.5l-5 -3l5 -3l5 3v5.5l-5 3z" /><path d="M2 13.5v5.5l5 3" /><path d="M7 16.545l5 -3.03" /><path d="M17 16.5l-5 -3l5 -3l5 3v5.5l-5 3z" /><path d="M12 19l5 3" /><path d="M17 16.5l5 -3" /><path d="M12 13.5v-5.5l-5 -3l5 -3l5 3v5.5" /><path d="M7 5.03v5.455" /><path d="M12 8l5 -3" /></svg> {{ connection.kit_sku }} - {{ connection.kit_descricao }}</strong>
              <small>{{ connection.quantity_per_kit }}x por kit</small>
            </div>
            <button 
              @click="removeFromKit(connection.kit_id)" 
              class="btn-disconnect"
              title="Desconectar deste kit"
            >
              Desconectar
            </button>
          </div>
        </div>
      </div>

      <!-- Dimensões -->
      <div class="dims-grid">
        <div class="form-group" :class="{ 'has-error': errors.altura }">
          <label for="sku-height">Altura (cm)</label>
          <input id="sku-height" type="number" v-model.number="editableSku.dimensoes.altura" min="0" step="0.1" required>
          <small v-if="errors.altura" class="err">{{ errors.altura }}</small>
        </div>
        <div class="form-group" :class="{ 'has-error': errors.largura }">
          <label for="sku-width">Largura (cm)</label>
          <input id="sku-width" type="number" v-model.number="editableSku.dimensoes.largura" min="0" step="0.1" required>
          <small v-if="errors.largura" class="err">{{ errors.largura }}</small>
        </div>
        <div class="form-group" :class="{ 'has-error': errors.comprimento }">
          <label for="sku-length">Comprimento (cm)</label>
          <input id="sku-length" type="number" v-model.number="editableSku.dimensoes.comprimento" min="0" step="0.1" required>
          <small v-if="errors.comprimento" class="err">{{ errors.comprimento }}</small>
        </div>
      </div>

      <!-- Tipo de Pacote -->
      <div class="form-group">
        <label>Tipo de Pacote</label>
        <div class="package-type-cards">
          <div
            v-for="type in packageTypes"
            :key="type.id"
            class="package-type-card"
            :class="{ selected: editableSku.package_type_id === type.id }"
            @click="setPackageType(type)"
          >
            <div class="card-content">
              <strong class="card-title">{{ type.name }}</strong>
              <div v-if="type.value != null" class="card-value">R$ {{ Number(type.value).toFixed(2) }}</div>
              <div v-if="type.description" class="card-desc">{{ type.description }}</div>
            </div>
          </div>
        </div>
        <small v-if="!editableSku.package_type_id" style="color:#6b7280;">Opcional, mas recomendado</small>
      </div>

      <!-- Quantidade (sempre visível para SKUs individuais) -->
      <div v-if="!isEditing" class="form-group" :class="{ 'has-error': errors.quantidade }">
        <label for="sku-quantity">Quantidade de Entrada Inicial</label>
        <input id="sku-quantity" type="number" v-model.number="editableSku.quantidade" min="0" required>
        <small v-if="errors.quantidade" class="err">{{ errors.quantidade }}</small>
      </div>
    </form>

    <!-- Footer -->
    <template #footer>
      <div class="modal-actions">
        <button @click="$emit('close')" type="button" class="btn btn-secondary">Cancelar</button>
        <button @click="handleSave" type="button" class="btn btn-primary" :disabled="!isValid">Salvar</button>
      </div>
    </template>
  </UniversalModal>
</template>

<script>
import { defineComponent, ref, watch, computed, defineExpose } from 'vue'
import UniversalModal from '../UniversalModal.vue'

export default defineComponent({
  name: 'SkuFormModal',
  components: { UniversalModal },
  props: {
    isOpen: Boolean,
    isEditing: Boolean,
    skuData: Object,
    packageTypes: { type: Array, default: () => [] },
    activeKits: { type: Array, default: () => [] },
    skuKitConnections: { type: Array, default: () => [] },
  },
  emits: ['close', 'save', 'open-package-select', 'disconnect-from-kit'],
  setup(props, { emit }) {
    console.log('✅ [SkuFormModal] Component instance created.');
    
    const editableSku = ref({
      id: null,
      sku: '',
      descricao: '',
      dimensoes: { altura: null, largura: null, comprimento: null },
      quantidade: null,
      package_type_id: null
    })
    
    // Estados para conexão com kits
    const selectedKitsForConnection = ref([])
    const kitQuantities = ref({})
    
    watch(() => props.isOpen, (open) => {
      if (open) {
        console.log('🔧 [SkuFormModal] Modal opened. Initializing with skuData:', props.skuData);
        const base = props.skuData || {}
        editableSku.value = {
          id: base.id ?? null,
          sku: base.sku || '',
          descricao: base.descricao || '',
          dimensoes: {
            altura: Number(base?.dimensoes?.altura ?? 0),
            largura: Number(base?.dimensoes?.largura ?? 0),
            comprimento: Number(base?.dimensoes?.comprimento ?? 0),
          },
          quantidade: props.isEditing ? null : Number(base?.quantidade ?? 0),
          package_type_id: base?.package_type_id ?? null
        }
        console.log('🔧 [SkuFormModal] editableSku state initialized:', JSON.parse(JSON.stringify(editableSku.value)));
      }
    }, { immediate: true })

    const selectedPackageTypeName = computed(() => {
      const packageTypeId = editableSku.value.package_type_id;
      if (!packageTypeId) return 'Selecione um tipo...';
      const selected = (props.packageTypes || []).find(pt => pt.id === packageTypeId);
      return selected ? selected.name : 'Selecione um tipo...';
    });
    
    // Exibir info resumida de kits compostos (opcional)
    const debugActiveKits = computed(() => {
      return props.activeKits || []
    })

    const errors = computed(() => {
      const e = {}
      const s = editableSku.value

      const sku = String(s.sku ?? '').trim()
      const desc = String(s.descricao ?? '').trim()
      const alt = Number(s?.dimensoes?.altura)
      const lar = Number(s?.dimensoes?.largura)
      const com = Number(s?.dimensoes?.comprimento)
      const qnt = props.isEditing ? 1 : Number(s?.quantidade)

      if (!sku) e.sku = 'Informe o código SKU.'
      if (!desc) e.descricao = 'Informe a descrição.'
      if (!Number.isFinite(alt) || alt <= 0) e.altura = 'Altura deve ser maior que 0.'
      if (!Number.isFinite(lar) || lar <= 0) e.largura = 'Largura deve ser maior que 0.'
      if (!Number.isFinite(com) || com <= 0) e.comprimento = 'Comprimento deve ser maior que 0.'
      
      // Apenas validação para SKUs normais (não há mais kits neste modal)
      if (!props.isEditing) {
        if (!Number.isFinite(qnt) || qnt < 0) e.quantidade = 'Quantidade deve ser maior ou igual a 0.'
      }

      return e
    })
    const isValid = computed(() => Object.keys(errors.value).length === 0)

    // Funções para gerenciar conexões com kits
    const getQuantityForKit = (kitId) => {
      return kitQuantities.value[kitId] || 1
    }
    
    const setQuantityForKit = (kitId, quantity) => {
      kitQuantities.value[kitId] = Math.max(1, Number(quantity) || 1)
    }
    
    const getKitName = (kitId) => {
      const kit = (props.activeKits || []).find(k => k.id === kitId)
      return kit ? `${kit.sku} - ${kit.descricao}` : 'Kit não encontrado'
    }
    
    const toggleSelectAllKits = (event) => {
      if (event.target.checked) {
        selectedKitsForConnection.value = debugActiveKits.value.map(kit => kit.id)
        // Define quantidade padrão para todos os kits selecionados
        debugActiveKits.value.forEach(kit => {
          if (!kitQuantities.value[kit.id]) {
            kitQuantities.value[kit.id] = 1
          }
        })
      } else {
        selectedKitsForConnection.value = []
        kitQuantities.value = {}
      }
    }
    
    const removeFromKit = (kitId) => {
      emit('disconnect-from-kit', { skuId: editableSku.value.id, kitId })
    }

    function normalizedPayload() {
      const s = editableSku.value
      
      const payload = {
        sku: String(s.sku).trim(),
        descricao: String(s.descricao).trim(),
        dimensoes: {
          altura: Number(s.dimensoes.altura),
          largura: Number(s.dimensoes.largura),
          comprimento: Number(s.dimensoes.comprimento),
        },
        package_type_id: s.package_type_id ?? null,
        is_kit: false // Sempre SKU individual neste modal
      }
      
      if (props.isEditing) {
        payload.id = s.id ?? (props.skuData?.id ?? null)
      } else {
        payload.quantidade = Number(s.quantidade)
        
        // Adicionar conexões com kits para novos SKUs
        if (selectedKitsForConnection.value.length > 0) {
          payload.kit_connections = selectedKitsForConnection.value.map(kitId => ({
            kit_id: kitId,
            quantity_per_kit: getQuantityForKit(kitId)
          }))
        }
      }
      
      const finalPayload = JSON.parse(JSON.stringify(payload))
      return finalPayload
    }

    const handleSave = () => {
      if (!isValid.value) {
        let msg = Object.values(errors.value)[0] || 'Preencha todos os campos obrigatórios.'
        
        window.dispatchEvent(new CustomEvent('show-toast', {
          detail: { id: `sku-modal-invalid-${Date.now()}`, message: msg, type: 'error', duration: 3500 }
        }))
        return
      }
      
      const payload = normalizedPayload()
      emit('save', payload)
    }

    function openPackageTypeSelect() {
      console.log('🔧 [SkuFormModal] openPackageTypeSelect chamado')
      console.log('   > package_type_id atual:', editableSku.value.package_type_id)
      emit('open-package-select', { current: editableSku.value.package_type_id })
    }

    function setPackageType(packageType) {
      console.info('✅🎉 [SkuFormModal] SUCESSO: A função setPackageType foi chamada!');
      console.log('   > Recebido packageType:', packageType);
      // Garante reatividade profunda
      editableSku.value.package_type_id = packageType ? packageType.id : null;
      // Não é necessário forçar update, pois o computed depende do id
      console.log('   > package_type_id do SKU foi atualizado para:', editableSku.value.package_type_id)
    }

    defineExpose({ setPackageType });

    return { 
      editableSku, 
      selectedPackageTypeName,
      debugActiveKits,
      selectedKitsForConnection,
      kitQuantities,
      errors, 
      isValid, 
      handleSave, 
      openPackageTypeSelect,
      getQuantityForKit,
      setQuantityForKit,
      getKitName,
      toggleSelectAllKits,
      removeFromKit,
      setPackageType,
    }
  }
})
</script>

<style scoped>
.sku-form, .sku-form * { box-sizing: border-box; }
.sku-form { display: grid; grid-template-columns: 1fr; gap: 1rem; padding: 0.5rem 0.75rem; }
.form-group { display: flex; flex-direction: column; }
.form-group label { margin-bottom: 0.5rem; font-weight: 500; font-size: 0.9rem; color: #374151; }
.form-group input, .form-group textarea, .form-group select { width: 100%; padding: 0.6rem 0.8rem; border: 1px solid #d1d5db; border-radius: 0.5rem; font-size: 0.9rem; min-width: 0; }
.form-group textarea { resize: vertical; }

/* Button Styles */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  border-radius: 0.5rem;
  font-weight: 500;
  font-size: 0.875rem;
  cursor: pointer;
  border: none;
  transition: all 0.2s ease;
  white-space: nowrap;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
  transform: none !important;
}

.btn-primary {
  background: #3b82f6;
  color: white;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
}

.btn-primary:hover:not(:disabled) {
  background: #2563eb;
  box-shadow: 0 4px 12px rgba(59, 130, 246, 0.25);
  transform: translateY(-1px);
}

.btn-secondary {
  background: #f3f4f6;
  color: #374151;
  border: 1px solid #d1d5db;
}

.btn-secondary:hover:not(:disabled) {
  background: #e5e7eb;
  border-color: #9ca3af;
}

/* Responsive Styles */
.dims-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.75rem;
}

@media (max-width: 768px) {
  .dims-grid {
    grid-template-columns: 1fr;
  }
  
  .btn {
    width: 100%;
    justify-content: center;
  }
}

/* Error States */
.has-error input,
.has-error textarea {
  border-color: #ef4444;
}

.err {
  color: #ef4444;
  font-size: 0.875rem;
  margin-top: 0.25rem;
}

/* Modal Actions */
.modal-actions {
  display: flex;
  gap: 0.75rem;
  justify-content: flex-end;
}

/* Select Trigger */
.select-trigger {
  width: 100%;
  padding: 0.6rem 0.8rem;
  border: 1px solid #d1d5db;
  border-radius: 0.5rem;
  background: white;
  cursor: pointer;
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 0.9rem;
}

.select-trigger:hover {
  border-color: #3b82f6;
}

.chevron-icon {
  transition: transform 0.2s;
}

/* Package Type Cards -- REVISED */
.package-type-cards {
  display: flex;
  gap: 0.75rem;
  flex-wrap: nowrap; /* Garante a rolagem em linha única */
  margin: 0.5rem 0;
  padding-bottom: 0.5rem; /* Espaço para a barra de rolagem */
  overflow-x: auto;
  scrollbar-width: thin;
  scrollbar-color: #d1d5db #f3f4f6;
}

.package-type-card {
  display: flex;
  flex-direction: row; /* Layout horizontal */
  align-items: center; /* Centraliza o conteúdo verticalmente */
  background: #f9fafb;
  border: 2px solid #e5e7eb;
  border-radius: 0.5rem;
  padding: 0.6rem 1rem; /* Padding ajustado */
  cursor: pointer;
  transition: all 0.2s ease-in-out;
  white-space: nowrap; /* Garante que o texto fique em uma linha */
  flex-shrink: 0; /* Impede que os cards encolham */
}

.package-type-card:hover {
  border-color: #d1d5db;
  background: #f3f4f6;
}

.package-type-card.selected {
  border-color: #3b82f6;
  box-shadow: 0 4px 10px rgba(59, 130, 246, 0.1);
  background: #eff6ff;
}

.package-type-card .card-content {
  display: flex;
  flex-direction: row; /* Layout horizontal para o conteúdo */
  align-items: baseline; /* Alinha o texto do título e do valor */
  gap: 0.65rem; /* Espaço entre título e valor */
  flex-grow: 1;
}

.package-type-card .card-title {
  font-size: 0.9rem;
  font-weight: 600;
  color: #374151;
}

.package-type-card.selected .card-title {
  color: #1e3a8a;
}

.package-type-card .card-value {
  font-size: 0.8rem;
  font-weight: 600;
  color: #166534; /* Verde mais escuro */
  background-color: #dcfce7; /* Fundo verde claro */
  padding: 0.15rem 0.5rem;
  border-radius: 999px; /* Formato de pílula */
  line-height: 1;
}

/* A descrição está oculta para manter o card em linha única, conforme solicitado */
.package-type-card .card-desc {
  display: none;
}

.package-type-card .card-check {
  color: #2563eb;
  font-weight: bold;
  font-size: 1rem;
  margin-left: 1rem;
  transition: transform 0.2s ease-out, opacity 0.2s;
  transform: scale(0.5);
  opacity: 0;
}

.package-type-card.selected .card-check {
  transform: scale(1);
  opacity: 1;
}


/* Kit Connection Section */
.kit-connection-section {
  margin: 1.5rem 0;
  padding: 1.5rem;
  background: linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%);
  border: 1px solid #0ea5e9;
  border-radius: 0.75rem;
}

/* Tabela de Seleção de Kits */
.kits-selection-table-container {
  max-height: 350px;
  overflow-y: auto;
  border: 1px solid #e5e7eb;
  border-radius: 0.75rem;
  background: white;
  margin-bottom: 1rem;
}

.kits-selection-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.875rem;
}

.kits-selection-table thead {
  background: #f8fafc;
  border-bottom: 2px solid #e5e7eb;
  position: sticky;
  top: 0;
  z-index: 10;
}

.kits-selection-table th {
  padding: 0.875rem 1rem;
  text-align: left;
  font-weight: 600;
  color: #374151;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  border-bottom: 1px solid #e5e7eb;
}

.kits-selection-table td {
  padding: 1rem;
  border-bottom: 1px solid #f3f4f6;
  vertical-align: middle;
}

.kit-selection-row {
  transition: all 0.2s ease;
  cursor: pointer;
}

.kit-selection-row:hover {
  background: #f8fafc;
}

.kit-selection-row.selected {
  background: #eff6ff;
  border-left: 3px solid #3b82f6;
}

.kit-selection-row.selected:hover {
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

.kit-info {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.kit-icon { font-size: 1.1rem; }

.kit-sku {
  font-family: ui-monospace, 'Courier New', monospace;
  font-weight: 600;
  color: #111827;
}

.kit-description {
  color: #6b7280;
  line-height: 1.4;
}

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

.quantity-placeholder {
  color: #9ca3af;
  font-style: italic;
}

.connection-summary {
  margin-top: 1rem;
  padding: 1rem;
  background: rgba(255, 255, 255, 0.8);
  border-radius: 0.5rem;
  border: 1px solid #bfdbfe;
}

.summary-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
  color: #1e40af;
}

.summary-icon { font-size: 1.25rem; }

.summary-items {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.summary-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.5rem;
  background: white;
  border-radius: 0.375rem;
  border: 1px solid #e5e7eb;
}

.summary-quantity {
  font-weight: 600;
  color: #0ea5e9;
}

/* Existing Connections Section */
.existing-connections-section {
  margin: 1.5rem 0;
  padding: 1.5rem;
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 0.75rem;
}

.existing-connections-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.connection-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1rem;
  background: white;
  border: 1px solid #d1d5db;
  border-radius: 0.5rem;
  box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
}

.connection-info {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.connection-info strong { color: #111827; }
.connection-info small { color: #6b7280; }

.btn-disconnect {
  padding: 0.5rem 1rem;
  background: #fef2f2;
  color: #dc2626;
  border: 1px solid #fecaca;
  border-radius: 0.375rem;
  cursor: pointer;
  font-size: 0.875rem;
  font-weight: 500;
  transition: all 0.2s;
}

.btn-disconnect:hover {
  background: #fee2e2;
  border-color: #fca5a5;
}

/* Responsividade da Tabela */
@media (max-width: 768px) {
  .kits-selection-table-container {
    max-height: 300px;
  }
  
  .kits-selection-table,
  .kits-selection-table thead,
  .kits-selection-table tbody,
  .kits-selection-table th,
  .kits-selection-table td,
  .kits-selection-table tr {
    display: block;
  }
  
  .kits-selection-table thead tr {
    position: absolute;
    top: -9999px;
    left: -9999px;
  }
  
  .kits-selection-table tr {
    border: 1px solid #e5e7eb;
    margin-bottom: 0.5rem;
    border-radius: 0.5rem;
    background: white;
    padding: 0.75rem;
  }
  
  .kits-selection-table tr.selected {
    border-color: #3b82f6;
    background: #eff6ff;
  }
  
  .kits-selection-table td {
    border: none;
    position: relative;
    padding: 0.5rem 0;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  
  .kits-selection-table td::before {
    content: attr(data-label);
    font-weight: 600;
    color: #374151;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    min-width: 100px;
  }
  
  .select-cell {
    justify-content: flex-start;
  }
  
  .quantity-input {
    width: 80px;
  }
  
  .connection-item {
    flex-direction: column;
    align-items: stretch;
    gap: 1rem;
  }
}
</style>
