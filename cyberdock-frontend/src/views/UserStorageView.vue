<template>
  <div class="storage-view-wrapper" ref="viewWrapperEl">
    <div v-if="isLoading || !userId" class="skeleton-loader">
      <div class="skeleton-grid">
        <div class="skeleton-card" v-for="n in 5" :key="`sk-card-${n}`"></div>
      </div>
      <div class="skeleton-table">
        <div class="skeleton-table-header"></div>
        <div class="skeleton-table-row" v-for="n in 8" :key="`sk-row-${n}`"></div>
      </div>
    </div>

    <div v-else class="content-wrapper">
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
      v-if="isKitManagementModalOpen"
      :is-open="isKitManagementModalOpen"
      :package-types="packageTypes"
      :user-id="userId"
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

export default defineComponent({
  name: 'UserStorageView',
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

    const { activeKits, loadActiveKits } = useKitManagement(reactiveUserId)

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

    const isEditing = ref(false)
    const currentSku = ref(null)
    const skuToDelete = ref(null)
    const skuToAdjust = ref(null)
    const skuForHistory = ref(null)
    const stockMovements = ref([])
    const isLoadingHistory = ref(false)
    const componentToAdjust = ref(null)

    const expeditedSalesCount = computed(() => {
      if (!sales.value) return 0
      return sales.value.filter(sale => sale.shipping_status === 'expedited').length
    })

    const quantityByPackageType = computed(() => {
      if (!skus.value || !packageTypes.value) return {}
      
      const result = {}
      packageTypes.value.forEach(pkgType => {
        result[pkgType.name] = skus.value
          .filter(sku => sku.package_type_id === pkgType.id)
          .reduce((total, sku) => total + (sku.quantidade || 0), 0)
      })
      return result
    })

    // SKU Form Methods
    const openAddModal = () => {
      isEditing.value = false
      currentSku.value = null
      isSkuModalOpen.value = true
    }

    const openEditModal = (sku) => {
      isEditing.value = true
      currentSku.value = { ...sku }
      isSkuModalOpen.value = true
    }

    const closeSkuModal = () => {
      isSkuModalOpen.value = false
      currentSku.value = null
      isEditing.value = false
    }

    const handleSaveSku = async (skuData) => {
      try {
        if (isEditing.value) {
          await updateSku(skuData)
          toast('SKU atualizado com sucesso.', 'success')
        } else {
          await addSku(skuData)
          toast('SKU criado com sucesso.', 'success')
        }
        closeSkuModal()
      } catch (err) {
        toast(`Erro ao salvar SKU: ${err.message}`, 'error', 4200)
      }
    }

    // SKU Kit Connection Methods
    const skuKitConnections = ref([])
    const skuToConnect = ref(null)
    const isConnecting = ref(false)

    const openConnectToKitModal = async (sku) => {
      if (!sku || !sku.id) {
        toast('SKU inválido para conexão.', 'error');
        console.error('openConnectToKitModal: SKU inválido ou sem ID:', sku);
        return;
      }
      
      await loadActiveKits();
      skuToConnect.value = { ...sku };
      
      await nextTick();
      
      isConnectToKitModalOpen.value = true;
      
      await loadSkuKitConnections(sku.id);
    }


    const closeConnectToKitModal = () => {
      isConnectToKitModalOpen.value = false
      skuToConnect.value = null
      skuKitConnections.value = []
    }

    const handleConnectToKit = async (payload) => {
      try {
        isConnecting.value = true
        if (!payload || !payload.sku_id || !Array.isArray(payload.connections)) {
          throw new Error('Dados inválidos para conectar SKU aos kits.')
        }

        await connectSkuToKits(payload.sku_id, payload.connections)
        closeConnectToKitModal()
        toast('SKU conectado aos kits com sucesso.', 'success')
      } catch (err) {
        toast(`Erro ao conectar SKU aos kits: ${err.message}`, 'error', 4200)
      } finally {
        isConnecting.value = false
      }
    }

    const handleDisconnectFromKit = async ({ skuId, kitId }) => {
      try {
        await disconnectSkuFromKit(skuId, kitId)
        toast('SKU desconectado do kit com sucesso.', 'success')
        loadSkuKitConnections(skuId)
      } catch (err) {
        toast(`Erro ao desconectar SKU do kit: ${err.message}`, 'error', 4200)
      }
    }

    const loadSkuKitConnections = async (skuId) => {
      if (!skuId) {
        skuKitConnections.value = []
        return
      }
      
      try {
        skuKitConnections.value = await getSkuKitConnections(skuId)
      } catch (err) {
        console.error('Erro ao carregar conexões do SKU:', err)
        skuKitConnections.value = []
      }
    }

    const openDeleteModal = (sku) => {
      if (Number(sku.quantidade) > 0) {
        toast('O SKU só pode ser excluído se o estoque estiver zerado.', 'warning')
        return
      }
      skuToDelete.value = sku
      isDeleteModalOpen.value = true
    }
    
    const closeDeleteModal = () => { isDeleteModalOpen.value = false; skuToDelete.value = null }
    
    const handleConfirmDelete = async () => {
      try {
        await removeSku(skuToDelete.value.id)
        closeDeleteModal()
        toast('SKU excluído com sucesso.', 'success')
      } catch (err) {
        toast(`Erro ao excluir SKU: ${err.message}`, 'error', 4200)
      }
    }

    const openAdjustStockModal = (sku) => { skuToAdjust.value = sku; isAdjustStockModalOpen.value = true }
    const closeAdjustStockModal = () => { isAdjustStockModalOpen.value = false }
    
    const handleConfirmAdjustment = async ({ movementType, quantityChange, reason }) => {
      try {
        await adjustStock(skuToAdjust.value, movementType, quantityChange, reason)
        closeAdjustStockModal()
        toast('Estoque ajustado com sucesso.', 'success')
      } catch (err) {
        toast(`Erro ao ajustar estoque: ${err.message}`, 'error', 4200)
      }
    }

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
        const { post } = useApi()
        const result = await post(`/storage/component/${componentToAdjust.value.sku}/movements`, {
          userId: props.userId,
          movementType,
          quantityChange,
          reason,
          forceComponent: true
        })

        if (skus.value) {
          const skuIndex = skus.value.findIndex(s => s.id === componentToAdjust.value.id)
          if (skuIndex !== -1) {
            skus.value[skuIndex].quantidade = result.data.newQuantity
          }
        }

        if (isHistoryModalOpen.value && skuForHistory.value && skuForHistory.value.sku === componentToAdjust.value.sku) {
          try {
            stockMovements.value = await fetchStockMovements(componentToAdjust.value.sku)
          } catch (e) {
            console.warn('Não foi possível atualizar o histórico após o ajuste:', e)
          }
        }

        closeComponentStockModal()
        toast(`Estoque do componente ajustado com sucesso. ${result.message}`, 'success')
        
        if (result.data.affectedKits && result.data.affectedKits.length > 0) {
          const kitsInfo = result.data.affectedKits
            .map(kit => `${kit.kitCode}: ${kit.availableKits} kits disponíveis`)
            .join(', ')
          toast(`Kits afetados: ${kitsInfo}`, 'info', 5000)
        }
      } catch (err) {
        toast(`Erro ao ajustar estoque do componente: ${err.message}`, 'error', 4200)
      }
    }

    const handleDeleteMovement = async (movementId) => {
      if (!movementId) return
      try {
        await deleteMovement(movementId)
        toast('Movimentação excluída com sucesso.', 'success')
      } catch (err) {
        toast(`Erro ao excluir movimentação: ${err.message}`, 'error', 4200)
      }
    }

    const openHistoryModal = async (sku) => {
      skuForHistory.value = sku
      isHistoryModalOpen.value = true
      isLoadingHistory.value = true
      try {
        stockMovements.value = await fetchStockMovements(sku.sku)
      } catch (e) {
        toast('Não foi possível carregar o histórico.', 'error')
      } finally {
        isLoadingHistory.value = false
      }
    }
    
    const closeHistoryModal = () => { isHistoryModalOpen.value = false; skuForHistory.value = null; stockMovements.value = [] }

    const openPackageTypeSelect = () => {
      isPackageTypeSelectModalOpen.value = true
    }

    const selectPackageType = (packageType) => {
      if (skuFormModalRef.value && typeof skuFormModalRef.value.setPackageType === 'function') {
        skuFormModalRef.value.setPackageType(packageType)
      }
      
      // Atualizar currentSku se estiver editando, senão apenas fechar o modal
      if (isEditing.value && currentSku.value) {
        currentSku.value.package_type_id = packageType ? packageType.id : null
      }
      
      isPackageTypeSelectModalOpen.value = false
      if (packageType) toast(`Tipo de pacote selecionado: ${packageType.name}`, 'info', 2500)
    }

    const handleSavePackageType = async (packageTypeData, editing) => {
      try {
        if (editing) {
          await updatePackageType(packageTypeData)
          toast('Tipo de pacote atualizado.', 'success')
        } else {
          await addPackageType(packageTypeData)
          toast('Tipo de pacote criado.', 'success')
        }
      } catch (err) {
        toast(`Erro ao salvar tipo de pacote: ${err.message}`, 'error', 4200)
      }
    }

    const handleDeletePackageType = async (packageType) => {
      if (confirm(`Tem certeza que deseja excluir o tipo "${packageType.name}"?`)) {
        try {
          await removePackageType(packageType.id)
          toast('Tipo de pacote excluído.', 'success')
        } catch (err) {
          toast(`Erro ao excluir tipo de pacote: ${err.message}`, 'error', 4200)
        }
      }
    }
    
    const openPackageTypeManagerModal = () => {
      isPackageTypeManagerModalOpen.value = true
    }
    
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
      skus, volumeContratado, volumeConsumido, percentualOcupacao,
      isLoading, error, billingSummary,
      allMovements, isLoadingMovements, packageTypes, isLoadingPackageTypes, activeKits,
      sales, expeditedSalesCount, quantityByPackageType,
      isSkuModalOpen, isDeleteModalOpen, isAdjustStockModalOpen, isHistoryModalOpen,
      isPackageTypeManagerModalOpen, isPackageTypeSelectModalOpen, isKitManagementModalOpen, isConnectToKitModalOpen, isComponentStockModalOpen,
      skuFormModalRef, viewWrapperEl,
      isEditing, currentSku, skuToDelete, skuToAdjust, skuForHistory, stockMovements, isLoadingHistory, componentToAdjust,
      skuToConnect, 
      isConnecting,
      skuKitConnections,
      calcularVolumePorSku,
      openAddModal, openEditModal, closeSkuModal, handleSaveSku,
      openDeleteModal, closeDeleteModal, handleConfirmDelete,
      openAdjustStockModal, closeAdjustStockModal, handleConfirmAdjustment,
      openComponentStockModal, closeComponentStockModal, handleConfirmComponentAdjustment,
      openHistoryModal, closeHistoryModal,
      selectPackageType, openPackageTypeSelect, handleSavePackageType, handleDeletePackageType, openPackageTypeManagerModal,
      openKitManagementModal, closeKitManagementModal, handleKitCreated, handleKitUpdated, handleKitDeleted,
      openConnectToKitModal, closeConnectToKitModal, handleConnectToKit, handleDisconnectFromKit,
      handleDeleteMovement
    }
  }
})
</script>

<style scoped>  

.content-wrapper {
  display: grid;
  gap: 2rem;
}

.skeleton-loader {
  display: grid;
  gap: 2rem;
}

.skeleton-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  gap: 1rem;
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
}
</style>

