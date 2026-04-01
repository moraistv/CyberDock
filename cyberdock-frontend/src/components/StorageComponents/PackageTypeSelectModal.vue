<template>
  <UniversalModal
    title="Selecione o Tipo de Pacote"
    :is-open="isOpen"
    :z-index="10010"
    @close="$emit('close')"
  >
    <div class="package-type-selection">
      <div v-if="isLoading" class="loading">Carregando...</div>
      <ul v-else class="selection-list">
        <li class="list-item none-option" @click="select(null)">
          <span>Nenhum (Remover associação)</span>
        </li>
        <li
          class="list-item"
          v-for="pt in packageTypes"
          :key="pt.id"
          @click="select(pt)"
        >
          <span class="item-name">{{ pt.name }}</span>
          <span class="price-tag">{{ formatCurrency(pt.price) }}</span>
        </li>
      </ul>
    </div>
  </UniversalModal>
</template>

<script>
import { defineComponent } from 'vue';
import UniversalModal from '../UniversalModal.vue';

export default defineComponent({
  name: 'PackageTypeSelectModal',
  components: { UniversalModal },
  props: {
    isOpen: Boolean,
    packageTypes: Array,
    isLoading: Boolean,
  },
  emits: ['close', 'select'],
  setup(props, { emit }) {
    const formatCurrency = (value) => {
      if (typeof value !== 'number') return 'R$ 0,00';
      return value.toLocaleString('pt-BR', {
        style: 'currency',
        currency: 'BRL',
      });
    };

    const select = (packageType) => {
      console.log('🔧 [PackageTypeSelectModal] select chamado com:', packageType);
      console.log('🔧 [PackageTypeSelectModal] packageType.id:', packageType?.id);
      console.log('🔧 [PackageTypeSelectModal] packageType.name:', packageType?.name);
      emit('select', packageType);
    };

    return { formatCurrency, select };
  },
});
</script>

<style scoped>
.package-type-selection {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.loading {
  text-align: center;
  padding: 1rem;
  font-size: 0.9rem;
  color: #6b7280;
}

.selection-list {
  list-style: none;
  padding: 0;
  margin: 0;
  max-height: 50vh;
  overflow-y: auto;
  scrollbar-width: none; /* Firefox */
}
.selection-list::-webkit-scrollbar {
  display: none; /* Chrome/Safari */
}

.list-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.85rem 1rem;
  border-radius: 0.5rem;
  cursor: pointer;
  background-color: #fff;
  transition: background-color 0.2s, box-shadow 0.2s;
  border: 1px solid transparent;
}

.list-item:hover {
  background-color: #f9fafb;
  border-color: #e5e7eb;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
}

.none-option {
  font-weight: 500;
  color: #ef4444;
}

.item-name {
  font-size: 0.9rem;
  color: #111827;
}

.price-tag {
  font-weight: 500;
  color: #16a34a;
  font-size: 0.85rem;
}
</style>
