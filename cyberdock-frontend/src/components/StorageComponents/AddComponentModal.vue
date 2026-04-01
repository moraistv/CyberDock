<template>
  <UniversalModal
    title="Adicionar Componente ao Kit"
    :is-open="isOpen"
    size="lg"
    @close="$emit('close')"
  >
    <div class="add-component-modal">
      <!-- Search -->
      <div class="search-section">
        <div class="search-input">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8"/>
            <path d="M21 21l-4.35-4.35"/>
          </svg>
          <input 
            v-model="searchQuery" 
            type="text" 
            placeholder="Buscar por SKU ou descrição..."
            class="search-field"
          >
        </div>
        <div class="search-results-count" v-if="searchQuery">
          {{ filteredSkus.length }} resultado(s) encontrado(s)
        </div>
      </div>

      <!-- Available SKUs List -->
      <div class="skus-section">
        <h4 class="section-title">SKUs Disponíveis</h4>
        
        <!-- Loading State -->
        <div v-if="isLoading" class="loading-state">
          <div class="loading-spinner">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 12a9 9 0 11-6.219-8.56"/>
            </svg>
          </div>
          <p>Carregando SKUs disponíveis...</p>
        </div>

        <!-- Empty State -->
        <div v-else-if="filteredSkus.length === 0" class="empty-state">
          <div class="empty-icon"><svg  xmlns="http://www.w3.org/2000/svg"  width="24"  height="24"  viewBox="0 0 24 24"  fill="none"  stroke="currentColor"  stroke-width="2"  stroke-linecap="round"  stroke-linejoin="round"  class="icon icon-tabler icons-tabler-outline icon-tabler-packages"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M7 16.5l-5 -3l5 -3l5 3v5.5l-5 3z" /><path d="M2 13.5v5.5l5 3" /><path d="M7 16.545l5 -3.03" /><path d="M17 16.5l-5 -3l5 -3l5 3v5.5l-5 3z" /><path d="M12 19l5 3" /><path d="M17 16.5l5 -3" /><path d="M12 13.5v-5.5l-5 -3l5 -3l5 3v5.5" /><path d="M7 5.03v5.455" /><path d="M12 8l5 -3" /></svg></div>
          <h4>{{ searchQuery ? 'Nenhum SKU encontrado' : 'Nenhum SKU disponível' }}</h4>
          <p>{{ searchQuery ? 'Tente uma busca diferente.' : 'Todos os SKUs já foram adicionados ou não há SKUs com estoque.' }}</p>
        </div>

        <!-- SKUs Grid -->
        <div v-else class="skus-grid">
          <div 
            v-for="sku in filteredSkus" 
            :key="sku.id" 
            class="sku-card"
            @click="selectSku(sku)"
          >
            <div class="sku-header">
              <span class="sku-code">{{ sku.sku }}</span>
              <span class="sku-stock">{{ sku.quantidade }} un.</span>
            </div>
            <div class="sku-content">
              <h5 class="sku-title">{{ sku.descricao }}</h5>
              <div class="sku-details">
                <div class="detail-item">
                  <span class="detail-label">Dimensões:</span>
                  <span class="detail-value">
                    {{ sku.dimensoes.altura }}×{{ sku.dimensoes.largura }}×{{ sku.dimensoes.comprimento }} cm
                  </span>
                </div>
                <div class="detail-item">
                  <span class="detail-label">Volume:</span>
                  <span class="detail-value">{{ calculateVolume(sku).toFixed(4) }} m³</span>
                </div>
                <div v-if="sku.package_type_name" class="detail-item">
                  <span class="detail-label">Pacote:</span>
                  <span class="detail-value">{{ sku.package_type_name }}</span>
                </div>
              </div>
            </div>
            <div class="sku-actions">
              <button class="btn-select">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 5v14M5 12h14"/>
                </svg>
                Adicionar
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Currently in Kit -->
      <div v-if="existingComponents.length > 0" class="existing-section">
        <h4 class="section-title">Já no Kit</h4>
        <div class="existing-components">
          <div 
            v-for="component in existingComponents" 
            :key="component.child_sku_id"
            class="existing-component"
          >
            <span class="component-sku">{{ component.child_sku_code }}</span>
            <span class="component-description">{{ component.child_descricao }}</span>
            <span class="component-qty">{{ component.quantity_per_kit }}x</span>
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
      </div>
    </template>
  </UniversalModal>
</template>

<script>
import { defineComponent, ref, computed } from 'vue'
import UniversalModal from '@/components/UniversalModal.vue'

export default defineComponent({
  name: 'AddComponentModal',
  components: {
    UniversalModal
  },
  props: {
    isOpen: { type: Boolean, required: true },
    availableSkus: { type: Array, default: () => [] },
    existingComponents: { type: Array, default: () => [] },
    isLoading: { type: Boolean, default: false }
  },
  emits: ['close', 'add'],
  setup(props, { emit }) {
    const searchQuery = ref('')

    // Computed
    const filteredSkus = computed(() => {
      if (!searchQuery.value) {
        return props.availableSkus
      }
      
      const query = searchQuery.value.toLowerCase()
      return props.availableSkus.filter(sku => 
        sku.sku.toLowerCase().includes(query) ||
        sku.descricao.toLowerCase().includes(query)
      )
    })

    // Methods
    const selectSku = (sku) => {
      emit('add', sku)
    }

    const calculateVolume = (sku) => {
      if (!sku.dimensoes) return 0
      const { altura, largura, comprimento } = sku.dimensoes
      return (altura * largura * comprimento) / 1000000
    }

    return {
      searchQuery,
      filteredSkus,
      selectSku,
      calculateVolume
    }
  }
})
</script>

<style scoped>
.add-component-modal {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  max-height: 70vh;
}

.search-section {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.search-input {
  position: relative;
  display: flex;
  align-items: center;
}

.search-input svg {
  position: absolute;
  left: 0.75rem;
  color: #6b7280;
  z-index: 1;
}

.search-field {
  width: 100%;
  padding: 0.75rem 0.75rem 0.75rem 2.5rem;
  border: 1px solid #d1d5db;
  border-radius: 0.5rem;
  font-size: 0.875rem;
  background: white;
}

.search-field:focus {
  outline: none;
  border-color: #6366f1;
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
}

.search-results-count {
  font-size: 0.875rem;
  color: #6b7280;
}

.skus-section {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.section-title {
  margin: 0;
  color: #111827;
  font-size: 1.125rem;
  font-weight: 600;
}

.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 2rem;
  text-align: center;
  color: #6b7280;
}

.loading-spinner {
  margin-bottom: 0.75rem;
}

.loading-spinner svg {
  animation: spin 1s linear infinite;
  color: #6366f1;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 2rem;
  text-align: center;
}

.empty-icon {
  font-size: 2.5rem;
  margin-bottom: 1rem;
}

.empty-state h4 {
  margin: 0 0 0.5rem 0;
  color: #111827;
  font-size: 1.125rem;
}

.empty-state p {
  margin: 0;
  color: #6b7280;
}

.skus-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 1rem;
  overflow-y: auto;
  max-height: 400px;
  padding-right: 0.5rem;
}

.sku-card {
  border: 1px solid #e5e7eb;
  border-radius: 0.75rem;
  padding: 1rem;
  background: white;
  cursor: pointer;
  transition: all 0.2s;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.sku-card:hover {
  border-color: #6366f1;
  box-shadow: 0 4px 12px rgba(99, 102, 241, 0.1);
  transform: translateY(-1px);
}

.sku-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.sku-code {
  font-family: ui-monospace, 'Courier New', monospace;
  background: #f3f4f6;
  padding: 0.25rem 0.5rem;
  border-radius: 0.375rem;
  font-size: 0.875rem;
  font-weight: 600;
  color: #374151;
}

.sku-stock {
  background: #d1fae5;
  color: #065f46;
  padding: 0.25rem 0.5rem;
  border-radius: 0.375rem;
  font-size: 0.75rem;
  font-weight: 600;
}

.sku-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.sku-title {
  margin: 0;
  font-size: 0.875rem;
  font-weight: 600;
  color: #111827;
  line-height: 1.4;
}

.sku-details {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.detail-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 0.75rem;
}

.detail-label {
  color: #6b7280;
  font-weight: 500;
}

.detail-value {
  color: #374151;
  font-weight: 600;
}

.sku-actions {
  display: flex;
  justify-content: center;
}

.btn-select {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.5rem 1rem;
  border: none;
  border-radius: 0.375rem;
  background: #6366f1;
  color: white;
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-select:hover {
  background: #5b21b6;
}

.existing-section {
  border-top: 1px solid #e5e7eb;
  padding-top: 1rem;
}

.existing-components {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.75rem;
}

.existing-component {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  background: #f3f4f6;
  border: 1px solid #e5e7eb;
  border-radius: 0.5rem;
  font-size: 0.875rem;
}

.component-sku {
  font-family: ui-monospace, 'Courier New', monospace;
  font-weight: 600;
  color: #374151;
}

.component-description {
  color: #6b7280;
  max-width: 150px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.component-qty {
  color: #6366f1;
  font-weight: 600;
}

/* Button Styles */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  border: none;
  border-radius: 0.5rem;
  font-weight: 500;
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

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
  padding-top: 1rem;
  border-top: 1px solid #e5e7eb;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* Scrollbar Styling */
.skus-grid::-webkit-scrollbar {
  width: 6px;
}

.skus-grid::-webkit-scrollbar-track {
  background: #f1f5f9;
  border-radius: 3px;
}

.skus-grid::-webkit-scrollbar-thumb {
  background: #cbd5e1;
  border-radius: 3px;
}

.skus-grid::-webkit-scrollbar-thumb:hover {
  background: #94a3b8;
}

/* Responsive */
@media (max-width: 768px) {
  .skus-grid {
    grid-template-columns: 1fr;
    max-height: 300px;
  }

  .sku-card {
    padding: 0.75rem;
  }

  .detail-item {
    flex-direction: column;
    align-items: flex-start;
    gap: 0.125rem;
  }

  .existing-component {
    flex-direction: column;
    align-items: flex-start;
    gap: 0.25rem;
  }

  .component-description {
    max-width: none;
    white-space: normal;
  }
}
</style>