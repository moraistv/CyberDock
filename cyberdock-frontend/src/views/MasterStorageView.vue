<template>
  <div class="storage-view-wrapper" ref="viewWrapperEl">
    <div v-if="isLoading" class="skeleton-loader">
      <div class="skeleton-header">
        <div class="skeleton-title"></div>
        <div class="skeleton-actions"></div>
      </div>
      <div class="skeleton-grid">
        <div class="skeleton-card" v-for="n in 5" :key="`sk-card-${n}`"></div>
      </div>
      <div class="skeleton-table">
        <div class="skeleton-table-header"></div>
        <div class="skeleton-table-row" v-for="n in 8" :key="`sk-row-${n}`"></div>
      </div>
      <div class="skeleton-movements">
        <div class="skeleton-movements-header"></div>
        <div class="skeleton-movements-row" v-for="n in 5" :key="`sk-mov-${n}`"></div>
      </div>
    </div>

    <div v-show="!isLoading" class="content-wrapper">
      <!-- Cabeçalho específico para o master -->
      <div class="master-header">
        <h2>Armazenamento do Usuário</h2>
        <div class="master-actions">
          <button @click="openStorageModal" class="btn btn-primary">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 3a12 12 0 0 0 8.5 3a12 12 0 0 1 -8.5 15a12 12 0 0 1 -8.5 -15a12 12 0 0 0 8.5 -3" />
              <path d="M12 11m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" />
              <path d="M12 12l0 2.5" />
            </svg>
            Gerenciar Estoque
          </button>
        </div>
      </div>

      <StatsCardGrid
        :is-loading="isLoading"
        :billing-summary="billingSummary"
        :volume-consumido="volumeConsumido"
        :volume-contratado="volumeContratado"
        :percentual-ocupacao="percentualOcupacao"
        :expedited-sales-count="expeditedSalesCount"
        :quantity-by-package-type="quantityByPackageType"
      />

      <SkuTable
        :skus="skus"
        :active-kits="activeKits"
        :is-loading="isLoading"
        :error="error"
        :calcular-volume-por-sku="calcularVolumePorSku"
        @add-sku="openAddModal"
        @edit-sku="openEditModal"
        @delete-sku="openDeleteModal"
        @adjust-stock="openAdjustStockModal"
        @open-history="openHistoryModal"
        @open-package-manager="openPackageTypeManagerModal"
        @open-kit-manager="openKitManagementModal"
        @connect-to-kit="openConnectToKitModal"
        @adjust-component-stock="openComponentStockModal"
      />

      <StockMovementsTable
        :movements="allMovements"
        :is-loading="isLoadingMovements"
        @delete="handleDeleteMovement"
      />
    </div>

    <SkuFormModal
      ref="skuFormModalRef"
      :is-open="isSkuModalOpen"
      :is-editing="isEditing"
      :sku-data="currentSku"
      :package-types="packageTypes"
      :active-kits="activeKits"
      :sku-kit-connections="skuKitConnections"
      @close="closeSkuModal"              
      @open-package-select="openPackageTypeSelect"
      @save="handleSaveSku"
      @disconnect-from-kit="handleDisconnectFromKit"
    />

    <PackageTypeSelectModal
      :is-open="isPackageTypeSelectModalOpen"
      :package-types="packageTypes"
      :is-loading="isLoadingPackageTypes"
      @close="isPackageTypeSelectModalOpen = false"
      @select="selectPackageType"
    />

    <PackageTypeManagerModal
      :is-open="isPackageTypeManagerModalOpen"
      :package-types="packageTypes"
      :is-loading="isLoadingPackageTypes"
      @close="isPackageTypeManagerModalOpen = false"
      @save="handleSavePackageType"
      @delete="handleDeletePackageType"
    />

    <AdjustStockModal
      :is-open="isAdjustStockModalOpen"
      :sku="skuToAdjust"
      @close="closeAdjustStockModal"
      @confirm="handleConfirmAdjustment"
    />

    <ComponentStockAdjustModal
      :is-open="isComponentStockModalOpen"
      :sku="componentToAdjust"
      @close="closeComponentStockModal"
      @confirm="handleConfirmComponentAdjustment"
    />

    <SkuHistoryModal
      :is-open="isHistoryModalOpen"
      :sku="skuForHistory"
      :movements="stockMovements"
      :is-loading="isLoadingHistory"
      @close="closeHistoryModal"
    />

    <ConfirmDeleteModal
      :is-open="isDeleteModalOpen"
      :sku="skuToDelete"
      @close="closeDeleteModal"
      @confirm="handleConfirmDelete"
    />

    <KitManagementModal
      :is-open="isKitManagementModalOpen"
      :package-types="packageTypes"
      :user-id="reactiveUserId"
      @close="closeKitManagementModal"
      @kit-created="handleKitCreated"
      @kit-updated="handleKitUpdated"
      @kit-deleted="handleKitDeleted"
    />

    <ConnectToKitModal
      :is-open="isConnectToKitModalOpen"
      :sku="skuToConnect"
      :available-kits="activeKits"
      :is-connecting="isConnecting"
      @close="closeConnectToKitModal"
      @connect="handleConnectToKit"
      @create-kit="openKitManagementModal"
    />

    <!-- Modal de gerenciamento de estoque -->
    <UniversalModal
      :title="'Gerenciar Estoque'"
      :is-open="isStorageModalOpen"
      size="xl"
      @close="closeStorageModal"
    >
      <div class="storage-management">
        <div class="storage-actions">
          <button @click="openSkuModal" class="btn btn-primary">
            Criar SKU Individual
          </button>
          <button @click="openKitParentModal" class="btn btn-secondary">
            Gerenciar Kits Pai
          </button>
          <button @click="openKitManagementModal" class="btn btn-secondary">
            Gerenciar Kits
          </button>
          <button @click="testKitParents" class="btn btn-accent">
            Testar Kit Parents
          </button>
        </div>
      </div>
    </UniversalModal>
  </div>
</template>

<script>
import { defineComponent, ref, computed, watchEffect, nextTick } from 'vue'
import { gsap } from 'gsap'
import { useUserStorage } from '@/composables/useUserStorage'
import { useSalesForUser } from '@/composables/useSalesForUser'
import { useKitManagement } from '@/composables/useKitManagement'
import { useApi } from '@/composables/useApi'

import StatsCardGrid from '../components/StorageComponents/StatsCardGrid.vue'
import SkuTable from '../components/StorageComponents/SkuTable.vue'
import SkuFormModal from '../components/StorageComponents/SkuFormModal.vue'
import PackageTypeManagerModal from '../components/StorageComponents/PackageTypeManagerModal.vue'
import AdjustStockModal from '../components/StorageComponents/AdjustStockModal.vue'
import ComponentStockAdjustModal from '../components/StorageComponents/ComponentStockAdjustModal.vue'
import SkuHistoryModal from '../components/StorageComponents/SkuHistoryModal.vue'
import ConfirmDeleteModal from '../components/StorageComponents/ConfirmDeleteModal.vue'
import PackageTypeSelectModal from '../components/StorageComponents/PackageTypeSelectModal.vue'
import KitManagementModal from '../components/StorageComponents/KitManagementModal.vue'
import ConnectToKitModal from '../components/StorageComponents/ConnectToKitModal.vue'
import StockMovementsTable from '../components/StockMovementsTable.vue'
import UniversalModal from '../components/UniversalModal.vue'
import { useKitParent } from '@/composables/useKitParent'

export default defineComponent({
  name: 'MasterStorageView',
  components: {
    StatsCardGrid,
    SkuTable,
    SkuFormModal,
    PackageTypeManagerModal,
    AdjustStockModal,
    ComponentStockAdjustModal,
    SkuHistoryModal,
    ConfirmDeleteModal,
    PackageTypeSelectModal,
    KitManagementModal,
    ConnectToKitModal,
    StockMovementsTable,
    UniversalModal,
  },
  props: {
    userId: { type: String, required: true }
  },
  setup(props) {
    const reactiveUserId = computed(() => props.userId)
    const initialLoadComplete = ref(false)
    const viewWrapperEl = ref(null)

    const {
      skus, volumeContratado, volumeConsumido, percentualOcupacao,
      isLoading, error, billingSummary,
      allMovements, isLoadingMovements,
      packageTypes, isLoadingPackageTypes,
      addSku, updateSku, removeSku, adjustStock,
      fetchStockMovements, calcularVolumePorSku,
      addPackageType, updatePackageType, removePackageType,
      deleteMovement, connectSkuToKits, disconnectSkuFromKit, getSkuKitConnections,
    } = useUserStorage(reactiveUserId, () => {
      initialLoadComplete.value = true
    })

    const { sales } = useSalesForUser(reactiveUserId)
    const { activeKits } = useKitManagement(reactiveUserId)
    const { activeKitParents, loadActiveKitParents } = useKitParent(reactiveUserId)

    const toast = (message, type = 'info', duration = 3200) => {
      window.dispatchEvent(new CustomEvent('show-toast', {
        detail: { id: `${type}-${Date.now()}-${Math.random().toString(36).slice(2,7)}`, message, type, duration }
      }))
    }

    const isSkuModalOpen = ref(false)
    const skuFormModalRef = ref(null)
    const isDeleteModalOpen = ref(false)
    const isAdjustStockModalOpen = ref(false)
    const isHistoryModalOpen = ref(false)
    const isPackageTypeManagerModalOpen = ref(false)
    const isPackageTypeSelectModalOpen = ref(false)
    const isKitManagementModalOpen = ref(false)
    const isConnectToKitModalOpen = ref(false)
    const isComponentStockModalOpen = ref(false)
    const isStorageModalOpen = ref(false)

    const isEditing = ref(false)
    const currentSku = ref(null)
    const skuToDelete = ref(null)
    const skuToAdjust = ref(null)
    const skuForHistory = ref(null)
    const skuToConnect = ref(null)
    const componentToAdjust = ref(null)
    const stockMovements = ref([])
    const isLoadingHistory = ref(false)
    const skuKitConnections = ref([])
    const isConnecting = ref(false)

    // Computed properties
    const expeditedSalesCount = computed(() => {
      if (!sales.value) return { common: 0, premium: 0 }
      return {
        common: sales.value.filter(s => s.expeditionType === 'common').length,
        premium: sales.value.filter(s => s.expeditionType === 'premium').length
      }
    })

    const quantityByPackageType = computed(() => {
      if (!skus.value) return []
      
      const result = []
      const packageMap = new Map()
      
      skus.value.forEach(sku => {
        if (sku.package_type_name && !sku.is_kit) {
          const current = packageMap.get(sku.package_type_name) || 0
          packageMap.set(sku.package_type_name, current + sku.quantidade)
        }
      })
      
      packageMap.forEach((quantity, name) => {
        result.push({ name, quantity })
      })
      
      return result
    })

    // SKU Modal Methods
    const openAddModal = () => {
      isEditing.value = false
      currentSku.value = null
      isSkuModalOpen.value = true
    }

    const openEditModal = (sku) => {
      isEditing.value = true
      currentSku.value = { ...sku }
      isSkuModalOpen.value = true
      
      // Carregar conexões de kit para este SKU
      getSkuKitConnections(sku.sku).then(connections => {
        skuKitConnections.value = connections
      })
    }

    const closeSkuModal = () => {
      isSkuModalOpen.value = false
      setTimeout(() => {
        isEditing.value = false
        currentSku.value = null
        skuKitConnections.value = []
      }, 300)
    }

    const handleSaveSku = async (skuData) => {
      try {
        if (isEditing.value) {
          await updateSku(skuData)
          toast('SKU atualizado com sucesso.', 'success')
        } else {
          await addSku(skuData)
          toast('SKU adicionado com sucesso.', 'success')
        }
        closeSkuModal()
      } catch (err) {
        toast(`Erro ao salvar SKU: ${err.message}`, 'error', 4200)
      }
    }

    // Delete Modal Methods
    const openDeleteModal = (sku) => {
      skuToDelete.value = sku
      isDeleteModalOpen.value = true
    }

    const closeDeleteModal = () => {
      isDeleteModalOpen.value = false
      skuToDelete.value = null
    }

    const handleConfirmDelete = async () => {
      try {
        await removeSku(skuToDelete.value.sku)
        toast('SKU removido com sucesso.', 'success')
        closeDeleteModal()
      } catch (err) {
        toast(`Erro ao remover SKU: ${err.message}`, 'error', 4200)
        closeDeleteModal()
      }
    }

    // Adjust Stock Modal Methods
    const openAdjustStockModal = (sku) => {
      skuToAdjust.value = sku
      isAdjustStockModalOpen.value = true
    }

    const closeAdjustStockModal = () => {
      isAdjustStockModalOpen.value = false
      skuToAdjust.value = null
    }

    const handleConfirmAdjustment = async ({ movementType, quantityChange, reason }) => {
      try {
        await adjustStock(skuToAdjust.value.sku, movementType, quantityChange, reason)
        toast('Estoque ajustado com sucesso.', 'success')
        closeAdjustStockModal()
      } catch (err) {
        toast(`Erro ao ajustar estoque: ${err.message}`, 'error', 4200)
      }
    }

    // Component Stock Adjustment Methods
    const openComponentStockModal = (sku) => { 
      componentToAdjust.value = sku
      isComponentStockModalOpen.value = true 
    }
    
    const closeComponentStockModal = () => { 
      isComponentStockModalOpen.value = false
      componentToAdjust.value = null
    }
    
    const handleConfirmComponentAdjustment = async ({ movementType, quantityChange, reason }) => {
      try {
        // Usar o composable useApi que já gerencia a autenticação
        const { post } = useApi()
        
        const result = await post(`/storage/component/${componentToAdjust.value.sku}/movements`, {
          userId: props.userId,
          movementType,
          quantityChange,
          reason,
          forceComponent: true
        })

        // Atualizar o SKU localmente com a nova quantidade
        if (skus.value) {
          const skuIndex = skus.value.findIndex(s => s.id === componentToAdjust.value.id)
          if (skuIndex !== -1) {
            skus.value[skuIndex].quantidade = result.data.newQuantity
          }
        }

        // Atualizar a lista de movimentações se estiver aberta
        if (isHistoryModalOpen.value && skuForHistory.value && skuForHistory.value.sku === componentToAdjust.value.sku) {
          try {
            stockMovements.value = await fetchStockMovements(componentToAdjust.value.sku)
          } catch (e) {
            console.error('Erro ao atualizar histórico após ajuste:', e)
          }
        }

        toast('Estoque do componente ajustado com sucesso.', 'success')
        closeComponentStockModal()
      } catch (err) {
        toast(`Erro ao ajustar estoque do componente: ${err.message}`, 'error', 4200)
      }
    }

    // History Modal Methods
    const openHistoryModal = async (sku) => {
      skuForHistory.value = sku
      isHistoryModalOpen.value = true
      isLoadingHistory.value = true
      
      try {
        stockMovements.value = await fetchStockMovements(sku.sku)
      } catch (err) {
        toast(`Erro ao carregar histórico: ${err.message}`, 'error')
      } finally {
        isLoadingHistory.value = false
      }
    }

    const closeHistoryModal = () => {
      isHistoryModalOpen.value = false
      skuForHistory.value = null
      stockMovements.value = []
    }

    // Package Type Methods
    const openPackageTypeSelect = () => {
      isPackageTypeSelectModalOpen.value = true
    }
    
    const selectPackageType = (packageType) => {
      if (skuFormModalRef.value) {
        skuFormModalRef.value.setPackageType(packageType)
      }
      isPackageTypeSelectModalOpen.value = false
    }

    const handleSavePackageType = async (packageTypeData) => {
      try {
        if (packageTypeData.id) {
          await updatePackageType(packageTypeData)
          toast('Tipo de pacote atualizado com sucesso.', 'success')
        } else {
          await addPackageType(packageTypeData)
          toast('Tipo de pacote adicionado com sucesso.', 'success')
        }
      } catch (err) {
        toast(`Erro ao salvar tipo de pacote: ${err.message}`, 'error', 4200)
      }
    }

    const handleDeletePackageType = async (packageTypeId) => {
      try {
        await removePackageType(packageTypeId)
        toast('Tipo de pacote removido com sucesso.', 'success')
      } catch (err) {
        toast(`Erro ao remover tipo de pacote: ${err.message}`, 'error', 4200)
      }
    }

    const openPackageTypeManagerModal = () => {
      isPackageTypeManagerModalOpen.value = true
    }
    
    // Kit Management Methods
    const openKitManagementModal = () => {
      isKitManagementModalOpen.value = true
    }
    
    const closeKitManagementModal = () => {
      isKitManagementModalOpen.value = false
    }
    
    const handleKitCreated = () => {
      closeKitManagementModal()
      toast('Kit criado com sucesso.', 'success')
    }
    
    const handleKitUpdated = () => {
      closeKitManagementModal()
      toast('Kit atualizado com sucesso.', 'success')
    }
    
    const handleKitDeleted = () => {
      closeKitManagementModal()
      toast('Kit excluído com sucesso.', 'success')
    }

    // Connect to Kit Methods
    const openConnectToKitModal = (sku) => {
      skuToConnect.value = sku
      isConnectToKitModalOpen.value = true
    }
    
    const closeConnectToKitModal = () => {
      isConnectToKitModalOpen.value = false
      skuToConnect.value = null
    }
    
    const handleConnectToKit = async (payload) => {
      try {
        isConnecting.value = true

        if (!payload) throw new Error('Dados inválidos para conectar SKU aos kits.')

        let skuId
        let connections = []

        if (payload.sku_id && Array.isArray(payload.connections)) {
          skuId = payload.sku_id
          connections = payload.connections.map(c => ({
            kit_id: c.kit_id ?? c.kitId,
            quantity_per_kit: c.quantity_per_kit ?? c.quantityPerKit ?? 1
          }))
        } else if (payload.kitId) {
          // legacy single-kit case
          skuId = skuToConnect.value?.id ?? skuToConnect.value?.sku
          connections = [{ kit_id: payload.kitId, quantity_per_kit: payload.quantityPerKit ?? 1 }]
        } else {
          throw new Error('Formato de payload inesperado ao conectar SKU.')
        }

        await connectSkuToKits(skuId, connections)
        toast('SKU conectado ao kit com sucesso.', 'success')
        closeConnectToKitModal()
      } catch (err) {
        toast(`Erro ao conectar SKU ao kit: ${err.message}`, 'error', 4200)
      } finally {
        isConnecting.value = false
      }
    }
    
    const handleDisconnectFromKit = async (kitId) => {
      try {
        await disconnectSkuFromKit(currentSku.value.sku, kitId)
        toast('SKU desconectado do kit com sucesso.', 'success')
        
        // Atualizar as conexões
        skuKitConnections.value = await getSkuKitConnections(currentSku.value.sku)
      } catch (err) {
        toast(`Erro ao desconectar SKU do kit: ${err.message}`, 'error', 4200)
      }
    }

    // Movement deletion
    const handleDeleteMovement = async (movementId) => {
      try {
        await deleteMovement(movementId)
        toast('Movimentação excluída com sucesso.', 'success')
        
        // Atualizar histórico se estiver aberto
        if (isHistoryModalOpen.value && skuForHistory.value) {
          stockMovements.value = await fetchStockMovements(skuForHistory.value.sku)
        }
      } catch (err) {
        toast(`Erro ao excluir movimentação: ${err.message}`, 'error', 4200)
      }
    }

    // Métodos para modal de gerenciamento de estoque
    const openStorageModal = () => {
      isStorageModalOpen.value = true
    }

    const closeStorageModal = () => {
      isStorageModalOpen.value = false
    }

    // Método para abrir modal de kit parent
    const openKitParentModal = () => {
      // Implementação futura
      toast('Funcionalidade em desenvolvimento', 'info')
    }

    // Método para testar kit parents
    const testKitParents = async () => {
      try {
        await loadActiveKitParents()
        const count = activeKitParents.value?.length || 0
        toast(`${count} Kit Parent(s) encontrado(s)!`, count > 0 ? 'success' : 'warning')
      } catch (error) {
        toast(`Erro ao carregar Kit Parents: ${error.message}`, 'error')
      }
    }

    // Animations
    watchEffect(() => {
      if (initialLoadComplete.value && viewWrapperEl.value) {
        nextTick(() => {
          gsap.fromTo(viewWrapperEl.value.children, 
            { opacity: 0, y: 20 },
            { opacity: 1, y: 0, duration: 0.6, stagger: 0.1, ease: 'power2.out' }
          )
        })
      }
    })

    return {
      // State
      isLoading, error, skus, billingSummary, volumeContratado, volumeConsumido, percentualOcupacao,
      allMovements, isLoadingMovements, packageTypes, isLoadingPackageTypes, activeKits,
      expeditedSalesCount, quantityByPackageType,
      isSkuModalOpen, isDeleteModalOpen, isAdjustStockModalOpen, isHistoryModalOpen,
      isPackageTypeManagerModalOpen, isPackageTypeSelectModalOpen, isKitManagementModalOpen, isConnectToKitModalOpen, isComponentStockModalOpen,
      isStorageModalOpen, skuFormModalRef, viewWrapperEl,
      isEditing, currentSku, skuToDelete, skuToAdjust, skuForHistory, stockMovements, isLoadingHistory, componentToAdjust,
      calcularVolumePorSku,
      openAddModal, openEditModal, closeSkuModal, handleSaveSku,
      openDeleteModal, closeDeleteModal, handleConfirmDelete,
      openAdjustStockModal, closeAdjustStockModal, handleConfirmAdjustment,
      openComponentStockModal, closeComponentStockModal, handleConfirmComponentAdjustment,
      openHistoryModal, closeHistoryModal,
      selectPackageType, handleSavePackageType, handleDeletePackageType, openPackageTypeManagerModal,
      openKitManagementModal, closeKitManagementModal, handleKitCreated, handleKitUpdated, handleKitDeleted,
      openConnectToKitModal, closeConnectToKitModal, handleConnectToKit, handleDisconnectFromKit,
      handleDeleteMovement,
      openStorageModal, closeStorageModal,
      openKitParentModal, testKitParents
    }
  }
})
</script>

<style scoped>
.storage-view-wrapper {
  margin: 0 auto;
}

.content-wrapper {
  display: grid;
  gap: 2rem;
}

/* Cabeçalho Master */
.master-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1.5rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid var(--border-color, #e5e7eb);
}

.master-header h2 {
  font-size: 1.5rem;
  font-weight: 600;
  margin: 0;
  color: var(--text-color, #1f2937);
}

.master-actions {
  display: flex;
  gap: 0.5rem;
}

.master-actions .btn svg {
  margin-right: 0.5rem;
}

/* Modal de Gerenciamento de Estoque */
.storage-management {
  padding: 1rem;
}

.storage-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  margin-bottom: 1rem;
}

.storage-actions .btn {
  min-width: 180px;
}

.skeleton-loader {
  display: grid;
  gap: 2rem;
}

/* Skeleton styles similar to MasterResumoCobranca */
.sk-header {
  height: 60px;
  background: linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%);
  background-size: 200% 100%;
  animation: shimmer 1.5s ease-in-out infinite;
  border-radius: 8px;
  margin-bottom: 1rem;
}

.sk-filters {
  display: flex;
  justify-content: space-between;
  margin-bottom: 1.5rem;
}

.sk-filter-group {
  width: 300px;
  height: 40px;
  background: linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%);
  background-size: 200% 100%;
  animation: shimmer 1.5s ease-in-out infinite;
  border-radius: 8px;
}

.sk-action-button {
  width: 150px;
  height: 40px;
  background: linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%);
  background-size: 200% 100%;
  animation: shimmer 1.5s ease-in-out infinite;
  border-radius: 8px;
}

/* Estilos para o skeleton loader */
.skeleton-loader {
  display: grid;
  gap: 2rem;
}

.skeleton-header {
  display: flex;
  justify-content: space-between;
  margin-bottom: 1rem;
}

.skeleton-title {
  width: 200px;
  height: 32px;
  background: linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%);
  background-size: 200% 100%;
  animation: shimmer 1.5s ease-in-out infinite;
  border-radius: 6px;
}

.skeleton-actions {
  width: 150px;
  height: 32px;
  background: linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%);
  background-size: 200% 100%;
  animation: shimmer 1.5s ease-in-out infinite;
  border-radius: 6px;
}

.skeleton-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  gap: 1rem;
  margin-bottom: 2rem;
}

.skeleton-card {
  height: 120px;
  background: linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%);
  background-size: 200% 100%;
  animation: shimmer 1.5s ease-in-out infinite;
  border-radius: 12px;
}

.skeleton-table {
  background: white;
  border-radius: 12px;
  padding: 1rem;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  margin-bottom: 2rem;
}

.skeleton-table-header {
  height: 40px;
  background: #f0f0f0;
  border-radius: 8px;
  margin-bottom: 1rem;
}

.skeleton-table-row {
  height: 20px;
  background: #f0f0f0;
  border-radius: 4px;
  margin-bottom: 0.5rem;
}

.skeleton-movements {
  background: white;
  border-radius: 12px;
  padding: 1rem;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.skeleton-movements-header {
  height: 40px;
  background: #f0f0f0;
  border-radius: 8px;
  margin-bottom: 1rem;
}

.skeleton-movements-row {
  height: 20px;
  background: #f0f0f0;
  border-radius: 4px;
  margin-bottom: 0.5rem;
}

@keyframes shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

@media (max-width: 768px) {
  .storage-view-wrapper {
    padding: 1rem;
  }
  
  .content-wrapper {
    gap: 1.5rem;
  }
  
  .sk-grid-5 {
    grid-template-columns: repeat(2, 1fr);
  }
  
  .master-header {
    flex-direction: column;
    align-items: flex-start;
    gap: 1rem;
  }
  
  .storage-actions {
    flex-direction: column;
  }
}
</style>