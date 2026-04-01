<template>
  <UniversalModal
    title="Gestão de Kits"
    :is-open="isOpen"
    size="full"
    @close="$emit('close')"
  >
    <div v-if="!userId" class="error-state">
      <div class="error-icon">⚠️</div>
      <p>Erro: User ID não disponível</p>
    </div>
    
    <div v-else class="kit-management">
      <!-- Header with Actions -->
      <div class="management-header">
        <div class="header-content">
          <h3>Gerenciar Kits de Produtos</h3>
          <p>Organize e controle a disponibilidade dos seus kits</p>
        </div>
        <div class="header-actions">
          <button @click="openCreateKitModal" class="btn btn-primary" :disabled="isOpeningForm">
            <SpinnerIcon v-if="isOpeningForm" />
            <svg v-else xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 5v14M5 12h14"/>
            </svg>
            Criar Novo Kit
          </button>
          <button @click="refreshKits" class="btn btn-secondary" :disabled="isLoading">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/>
              <path d="M21 3v5h-5"/>
              <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/>
              <path d="M3 21v-5h5"/>
            </svg>
            Atualizar
          </button>
        </div>
      </div>

      <!-- Stats Cards -->
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-icon active">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <path d="M9 12l2 2 4-4"/>
            </svg>
          </div>
          <div class="stat-content">
            <span class="stat-number">{{ stats.active }}</span>
            <span class="stat-label">Kits Ativos</span>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon inactive">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <path d="M15 9l-6 6"/>
              <path d="M9 9l6 6"/>
            </svg>
          </div>
          <div class="stat-content">
            <span class="stat-number">{{ stats.inactive }}</span>
            <span class="stat-label">Kits Inativos</span>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon total">
            <svg  xmlns="http://www.w3.org/2000/svg"  width="24"  height="24"  viewBox="0 0 24 24"  fill="none"  stroke="currentColor"  stroke-width="2"  stroke-linecap="round"  stroke-linejoin="round"  class="icon icon-tabler icons-tabler-outline icon-tabler-packages"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M7 16.5l-5 -3l5 -3l5 3v5.5l-5 3z" /><path d="M2 13.5v5.5l5 3" /><path d="M7 16.545l5 -3.03" /><path d="M17 16.5l-5 -3l5 -3l5 3v5.5l-5 3z" /><path d="M12 19l5 3" /><path d="M17 16.5l5 -3" /><path d="M12 13.5v-5.5l-5 -3l5 -3l5 3v5.5" /><path d="M7 5.03v5.455" /><path d="M12 8l5 -3" /></svg>
          </div>
          <div class="stat-content">
            <span class="stat-number">{{ stats.total }}</span>
            <span class="stat-label">Total de Kits</span>
          </div>
        </div>
      </div>

      <!-- Filter Tabs -->
      <div class="filter-tabs">
        <button 
          :class="['tab', { active: currentFilter === 'all' }]"
          @click="currentFilter = 'all'"
        >
          Todos os Kits
        </button>
        <button 
          :class="['tab', { active: currentFilter === 'active' }]"
          @click="currentFilter = 'active'"
        >
          Ativos
        </button>
        <button 
          :class="['tab', { active: currentFilter === 'inactive' }]"
          @click="currentFilter = 'inactive'"
        >
          Inativos
        </button>
      </div>

      <!-- Loading State -->
      <div v-if="isLoading" class="loading-state">
        <div class="loading-spinner-large">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 12a9 9 0 11-6.219-8.56"/>
          </svg>
        </div>
        <p>Carregando kits...</p>
      </div>

      <!-- Error State -->
      <div v-else-if="error" class="error-state">
        <div class="error-icon">⚠️</div>
        <p>{{ error }}</p>
        <button @click="refreshKits" class="btn btn-primary">Tentar Novamente</button>
      </div>

      <!-- Kits Table -->
      <div v-else class="kits-table-container">
        <table class="kits-table" v-if="filteredKits.length > 0">
          <thead>
            <tr>
              <th>Status</th>
              <th>SKU</th>
              <th>Descrição</th>
              <th>Componentes</th>
              <th>Estoque Calculado</th>
              <th>Volume (m³)</th>
              <th>Ações</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="kit in filteredKits" :key="kit.id" :class="{ inactive: !kit.ativo }">
              <td>
                <div class="status-cell">
                  <span :class="['status-badge', kit.ativo ? 'active' : 'inactive']">
                    {{ kit.ativo ? 'Ativo' : 'Inativo' }}
                  </span>
                </div>
              </td>
              <td>
                <span class="sku-code">{{ kit.sku }}</span>
              </td>
              <td class="kit-description">
                <div class="description-content">
                  <strong>{{ kit.descricao }}</strong>
                  <div v-if="kit.kit_components && kit.kit_components.length > 0" class="components-preview">
                    <small>{{ (kit.kit_components || []).length }} componente(s)</small>
                  </div>
                </div>
              </td>
              <td>
                <div class="components-list">
                  <!-- ✅ Fallback seguro para evitar erro de length em undefined -->
                  <div 
                    v-for="component in (kit.kit_components || [])" 
                    :key="component.child_sku_id"
                    class="component-item"
                  >
                    <span class="component-sku">{{ component.child_sku_code }}</span>
                    <span class="component-qty">{{ component.quantity_per_kit }}x</span>
                  </div>
                  <span v-if="!kit.kit_components || kit.kit_components.length === 0" class="no-components">
                    Sem componentes
                  </span>
                </div>
              </td>
              <td>
                <div class="stock-cell">
                  <span class="stock-number">
                    {{ kit.ativo ? calculateKitAvailableQuantity(kit) : '-' }}
                  </span>
                  <small v-if="kit.ativo">unidades</small>
                </div>
              </td>
              <td>
                <span class="volume">{{ calculateKitVolume(kit).toFixed(4) }}</span>
              </td>
              <td>
                <div class="action-buttons">
                  <button 
                    @click="toggleKitStatus(kit)" 
                    :class="['btn-action', kit.ativo ? 'deactivate' : 'activate']"
                    :title="kit.ativo ? 'Desativar kit' : 'Ativar kit'"
                    :disabled="actionLoading.toggle === kit.id"
                  >
                    <SpinnerIcon v-if="actionLoading.toggle === kit.id" />
                    <template v-else>
                      <svg v-if="kit.ativo" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"/>
                        <path d="M15 9l-6 6"/>
                        <path d="M9 9l6 6"/>
                      </svg>
                      <svg v-else xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"/>
                        <path d="M9 12l2 2 4-4"/>
                      </svg>
                    </template>
                  </button>
                  <button 
                    @click="editKit(kit)" 
                    class="btn-action edit"
                    title="Editar kit"
                    :disabled="actionLoading.edit === kit.id"
                  >
                    <SpinnerIcon v-if="actionLoading.edit === kit.id" />
                    <svg v-else xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M12 20h9"/>
                      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
                    </svg>
                  </button>
                  <button 
                    @click="deleteKit(kit)" 
                    class="btn-action delete"
                    title="Excluir kit"
                    :disabled="actionLoading.delete === kit.id"
                  >
                    <SpinnerIcon v-if="actionLoading.delete === kit.id" />
                    <svg v-else xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M3 6h18"/>
                      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>
                      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
                    </svg>
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>

        <!-- Empty State -->
        <div v-else class="empty-kits">
          <div class="empty-icon"><svg  xmlns="http://www.w3.org/2000/svg"  width="24"  height="24"  viewBox="0 0 24 24"  fill="none"  stroke="currentColor"  stroke-width="2"  stroke-linecap="round"  stroke-linejoin="round"  class="icon icon-tabler icons-tabler-outline icon-tabler-packages"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M7 16.5l-5 -3l5 -3l5 3v5.5l-5 3z" /><path d="M2 13.5v5.5l5 3" /><path d="M7 16.545l5 -3.03" /><path d="M17 16.5l-5 -3l5 -3l5 3v5.5l-5 3z" /><path d="M12 19l5 3" /><path d="M17 16.5l5 -3" /><path d="M12 13.5v-5.5l-5 -3l5 -3l5 3v5.5" /><path d="M7 5.03v5.455" /><path d="M12 8l5 -3" /></svg></div>
          <h3>{{ getEmptyStateTitle() }}</h3>
          <p>{{ getEmptyStateMessage() }}</p>
          <button v-if="currentFilter === 'all'" @click="openCreateKitModal" class="btn btn-primary">
            Criar Primeiro Kit
          </button>
        </div>
      </div>
    </div>

    <!-- Kit Form Modal -->
    <KitFormModal
      :is-open="isKitFormModalOpen"
      :is-editing="isEditingKit"
      :kit-data="currentKit"
      :package-types="packageTypes"
      :available-skus="availableChildSkus"
      :is-saving="isSaving"
      @close="closeKitFormModal"
      @save="handleKitSave"
    />

    <!-- Footer -->
    <template #footer>
      <div class="modal-actions">
        <button @click="$emit('close')" type="button" class="btn btn-secondary">Fechar</button>
      </div>
    </template>
  </UniversalModal>
</template>

<script>
import { defineComponent, ref, computed, onMounted, watch } from 'vue'
import { useKitManagement } from '@/composables/useKitManagement'
import UniversalModal from '@/components/UniversalModal.vue'
import KitFormModal from './KitFormModal.vue'

// Componente de Spinner para reutilização
const SpinnerIcon = defineComponent({
  name: 'SpinnerIcon',
  template: `
    <svg class="spinner" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 12a9 9 0 11-6.219-8.56"/>
    </svg>
  `
})

export default defineComponent({
  name: 'KitManagementModal',
  components: {
    UniversalModal,
    KitFormModal,
    SpinnerIcon
  },
  props: {
    isOpen: { type: Boolean, required: true },
    packageTypes: { type: Array, default: () => [] },
    availableSkus: { type: Array, default: () => [] },
    userId: { type: String, required: true }
  },
  emits: ['close', 'kit-created', 'kit-updated', 'kit-deleted'],
  setup(props, { emit }) {
    // Usar o userId da prop em vez de useAuth
    const userId = computed(() => {
      console.log('🔑 [KitManagementModal] userId recebido da prop:', props.userId);
      console.log('🔑 [KitManagementModal] props.userId type:', typeof props.userId);
      console.log('🔑 [KitManagementModal] props.userId truthy:', !!props.userId);
      return props.userId;
    });

    const {
      kits,
      isLoading,
      error,
      stats,
      loadKits,
      loadAvailableChildSkus,
      createKit,
      updateKit,
      toggleKitStatus: toggleStatus,
      deleteKit: removeKit,
      calculateKitAvailableQuantity
    } = useKitManagement(userId)

    // Debug: verificar se o userId está sendo passado corretamente
    console.log('🔍 [KitManagementModal] useKitManagement chamado com userId:', userId.value);

    // --- ESTADOS DE CARREGAMENTO ---
    const isSaving = ref(false) // Para o botão de salvar no formulário
    const isOpeningForm = ref(false) // Para os botões de criar/editar
    const actionLoading = ref({ // Para ações na tabela (por ID do kit)
      toggle: null,
      delete: null,
      edit: null,
    })

    // Local state
    const currentFilter = ref('all')
    const isKitFormModalOpen = ref(false)
    const isEditingKit = ref(false)
    const currentKit = ref(null)

    // Computed
    const filteredKits = computed(() => {
      switch (currentFilter.value) {
        case 'active':
          return kits.value.filter(kit => kit.ativo)
        case 'inactive':
          return kits.value.filter(kit => !kit.ativo)
        default:
          return kits.value
      }
    })

    // Methods
    const refreshKits = async () => {
      await loadKits()
    }

    const openCreateKitModal = async () => {
      isOpeningForm.value = true
      try {
  // Carregar SKUs disponíveis para adicionar ao kit antes de abrir
  await loadAvailableChildSkus()
  isEditingKit.value = false
  currentKit.value = null
  isKitFormModalOpen.value = true
      } catch (err) {
        // Exibir erro
      } finally {
        isOpeningForm.value = false
      }
    }

    const editKit = async (kit) => {
      actionLoading.value.edit = kit.id
      try {
        await loadAvailableChildSkus()
        isEditingKit.value = true
        currentKit.value = { ...kit }
        isKitFormModalOpen.value = true
      } catch (err) {
        // Exibir erro
      } finally {
        actionLoading.value.edit = null
      }
    }

    const closeKitFormModal = () => {
      isKitFormModalOpen.value = false
      currentKit.value = null
      isEditingKit.value = false
    }

    const handleKitSave = async (kitData) => {
      isSaving.value = true
      try {
        if (isEditingKit.value) {
          await updateKit(currentKit.value.id, kitData)
          emit('kit-updated')
        } else {
          await createKit(kitData)
          emit('kit-created')
        }
        closeKitFormModal()
        
        window.dispatchEvent(new CustomEvent('show-toast', {
          detail: {
            id: `kit-save-${Date.now()}`,
            message: `Kit ${isEditingKit.value ? 'atualizado' : 'criado'} com sucesso!`,
            type: 'success'
          }
        }))
      } catch (error) {
        window.dispatchEvent(new CustomEvent('show-toast', {
          detail: {
            id: `kit-error-${Date.now()}`,
            message: error.message,
            type: 'error'
          }
        }))
      } finally {
        isSaving.value = false
      }
    }

    const toggleKitStatus = async (kit) => {
      actionLoading.value.toggle = kit.id
      try {
        await toggleStatus(kit.id)
        
        window.dispatchEvent(new CustomEvent('show-toast', {
          detail: {
            id: `kit-toggle-${Date.now()}`,
            message: `Kit ${kit.ativo ? 'desativado' : 'ativado'} com sucesso!`,
            type: 'success'
          }
        }))
      } catch (error) {
        window.dispatchEvent(new CustomEvent('show-toast', {
          detail: {
            id: `kit-toggle-error-${Date.now()}`,
            message: error.message,
            type: 'error'
          }
        }))
      } finally {
        actionLoading.value.toggle = null
      }
    }

    const deleteKit = async (kit) => {
      if (!confirm(`Tem certeza que deseja excluir o kit "${kit.descricao}"?`)) {
        return
      }
      
      actionLoading.value.delete = kit.id
      try {
        await removeKit(kit.id)
        emit('kit-deleted')
        
        window.dispatchEvent(new CustomEvent('show-toast', {
          detail: {
            id: `kit-delete-${Date.now()}`,
            message: 'Kit excluído com sucesso!',
            type: 'success'
          }
        }))
      } catch (error) {
        window.dispatchEvent(new CustomEvent('show-toast', {
          detail: {
            id: `kit-delete-error-${Date.now()}`,
            message: error.message,
            type: 'error'
          }
        }))
      } finally {
        actionLoading.value.delete = null
      }
    }

    const calculateKitVolume = (kit) => {
      if (!kit.kit_components || kit.kit_components.length === 0) return 0
      
      return kit.kit_components.reduce((totalVolume, component) => {
        if (!component.child_dimensoes) return totalVolume
        
        const { altura, largura, comprimento } = component.child_dimensoes
        const componentVolume = (altura * largura * comprimento) / 1000000 // em m³
        const volumeInKit = componentVolume * component.quantity_per_kit
        
        return totalVolume + volumeInKit
      }, 0)
    }

    const getEmptyStateTitle = () => {
      switch (currentFilter.value) {
        case 'active': return 'Nenhum kit ativo'
        case 'inactive': return 'Nenhum kit inativo'
        default: return 'Nenhum kit criado'
      }
    }

    const getEmptyStateMessage = () => {
      switch (currentFilter.value) {
        case 'active': return 'Ative alguns kits para que apareçam na gestão de SKUs.'
        case 'inactive': return 'Todos os seus kits estão ativos no momento.'
        default: return 'Crie seu primeiro kit para começar a organizar produtos compostos.'
      }
    }

    watch(() => props.isOpen, (isOpen) => {
      console.log('🔑 [KitManagementModal] watch isOpen - isOpen:', isOpen);
      console.log('🔑 [KitManagementModal] watch isOpen - props.userId:', props.userId);
      console.log('🔑 [KitManagementModal] watch isOpen - userId.value:', userId.value);
      if (isOpen) {
        refreshKits()
      }
    })

    onMounted(() => {
      console.log('🔑 [KitManagementModal] onMounted - props.userId:', props.userId);
      console.log('🔑 [KitManagementModal] onMounted - userId.value:', userId.value);
      if (props.isOpen) {
        refreshKits()
      }
    })

    return {
      // State
      kits,
      isLoading,
      error,
      stats,
      currentFilter,
      filteredKits,
      isKitFormModalOpen,
      isEditingKit,
      currentKit,
      isSaving,
      isOpeningForm,
      actionLoading,
      
      // Methods
      refreshKits,
      openCreateKitModal,
      editKit,
      closeKitFormModal,
      handleKitSave,
      toggleKitStatus,
      deleteKit,
      calculateKitAvailableQuantity,
      calculateKitVolume,
      getEmptyStateTitle,
      getEmptyStateMessage
    }
  }
})
</script>

<style scoped>
.kit-management {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.management-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid #e5e7eb;
}

.header-content h3 {
  margin: 0 0 0.5rem 0;
  color: #111827;
  font-size: 1.5rem;
  font-weight: 700;
}

.header-content p {
  margin: 0;
  color: #6b7280;
  font-size: 0.875rem;
}

.header-actions {
  display: flex;
  gap: 0.75rem;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 1rem;
}

.stat-card {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 1rem;
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 0.75rem;
}

.stat-icon {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
}

.stat-icon.active { background: #10b981; }
.stat-icon.inactive { background: #ef4444; }
.stat-icon.total { background: #6366f1; }

.stat-content {
  display: flex;
  flex-direction: column;
}

.stat-number {
  font-size: 1.5rem;
  font-weight: 700;
  color: #111827;
}

.stat-label {
  font-size: 0.875rem;
  color: #6b7280;
}

.filter-tabs {
  display: flex;
  border-bottom: 1px solid #e5e7eb;
}

.tab {
  padding: 0.75rem 1rem;
  border: none;
  background: none;
  color: #6b7280;
  font-weight: 500;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: all 0.2s;
}

.tab:hover { color: #374151; }
.tab.active {
  color: #6366f1;
  border-bottom-color: #6366f1;
}

.loading-state,
.error-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 3rem;
  text-align: center;
  color: #6b7280;
}

.loading-spinner-large { margin-bottom: 1rem; }
.loading-spinner-large svg {
  animation: spin 1s linear infinite;
  color: #6366f1;
}

.error-state .error-icon {
  font-size: 3rem;
  margin-bottom: 1rem;
}

.kits-table-container { overflow-x: auto; }
.kits-table {
  width: 100%;
  border-collapse: collapse;
  background: white;
  border-radius: 0.75rem;
  overflow: hidden;
  box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.1);
}

.kits-table th,
.kits-table td {
  padding: 1rem;
  text-align: left;
  border-bottom: 1px solid #e5e7eb;
}

.kits-table thead th {
  background: #f9fafb;
  font-weight: 600;
  color: #374151;
  font-size: 0.875rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.kits-table tbody tr { transition: background-color 0.2s; }
.kits-table tbody tr:hover { background: #f9fafb; }
.kits-table tbody tr.inactive { opacity: 0.6; }

.status-badge {
  padding: 0.25rem 0.75rem;
  border-radius: 9999px;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.status-badge.active { background: #d1fae5; color: #065f46; }
.status-badge.inactive { background: #fee2e2; color: #991b1b; }

.sku-code {
  font-family: ui-monospace, 'Courier New', monospace;
  background: #f3f4f6;
  padding: 0.25rem 0.5rem;
  border-radius: 0.375rem;
  font-size: 0.875rem;
  font-weight: 600;
}

.kit-description .description-content {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.components-preview {
  color: #6b7280;
  font-size: 0.75rem;
}

.components-list {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.component-item {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.component-sku {
  font-family: ui-monospace, 'Courier New', monospace;
  background: #f3f4f6;
  padding: 0.125rem 0.375rem;
  border-radius: 0.25rem;
  font-size: 0.75rem;
}

.component-qty {
  font-size: 0.75rem;
  color: #6b7280;
  font-weight: 600;
}

.no-components {
  color: #9ca3af;
  font-style: italic;
  font-size: 0.875rem;
}

.stock-cell {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.stock-number {
  font-weight: 600;
  color: #111827;
}

.stock-cell small {
  color: #6b7280;
  font-size: 0.75rem;
}

.volume {
  font-family: ui-monospace, 'Courier New', monospace;
  font-weight: 600;
}

.action-buttons { display: flex; gap: 0.5rem; }
.btn-action {
  padding: 0.5rem;
  border: none;
  border-radius: 0.375rem;
  cursor: pointer;
  transition: all 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px; /* Fix size for loader */
  height: 34px; /* Fix size for loader */
}
.btn-action:disabled {
  cursor: not-allowed;
  opacity: 0.7;
}

.btn-action.activate { background: #d1fae5; color: #065f46; }
.btn-action.activate:hover:not(:disabled) { background: #a7f3d0; }
.btn-action.deactivate { background: #fee2e2; color: #991b1b; }
.btn-action.deactivate:hover:not(:disabled) { background: #fecaca; }
.btn-action.edit { background: #dbeafe; color: #1e40af; }
.btn-action.edit:hover:not(:disabled) { background: #bfdbfe; }
.btn-action.delete { background: #fee2e2; color: #dc2626; }
.btn-action.delete:hover:not(:disabled) { background: #fecaca; }

.empty-kits {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 3rem;
  text-align: center;
}

.empty-icon { font-size: 3rem; margin-bottom: 1rem; }
.empty-kits h3 { margin: 0 0 0.5rem 0; color: #111827; font-size: 1.25rem; }
.empty-kits p { margin: 0 0 1.5rem 0; color: #6b7280; }

/* Button Styles */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  border: none;
  border-radius: 0.5rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
  text-decoration: none;
  min-height: 38px;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-primary { background: #6366f1; color: white; }
.btn-primary:hover:not(:disabled) { background: #5b21b6; }
.btn-secondary { background: #f3f4f6; color: #374151; border: 1px solid #d1d5db; }
.btn-secondary:hover:not(:disabled) { background: #e5e7eb; }

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

.spinner {
  animation: spin 1s linear infinite;
}

/* Responsive */
@media (max-width: 768px) {
  .management-header { flex-direction: column; align-items: stretch; }
  .header-actions { flex-direction: column; }
  .stats-grid { grid-template-columns: 1fr; }
  .filter-tabs { flex-wrap: wrap; }
  .kits-table-container { overflow-x: scroll; }
  .action-buttons { flex-direction: column; }
}
</style>