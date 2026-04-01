import { ref } from 'vue';
import { useApi } from '@/composables/useApi';

export function usePackageTypes() {
  const api = useApi();
  const packageTypes = ref([]);
  const isLoading = ref(true);
  const error = ref(null);

  const fetchPackageTypes = async () => {
    isLoading.value = true;
    error.value = null;
    try {
      const data = await api.get('/storage/package-types');
      packageTypes.value = data || [];
    } catch (e) {
      console.error('Erro ao buscar tipos de pacotes:', e);
      error.value = e.message;
    } finally {
      isLoading.value = false;
    }
  };

  const addPackageType = async (packageTypeData) => {
    try {
      await api.post('/storage/package-types', packageTypeData);
      await fetchPackageTypes();
    } catch (e) {
      console.error('Erro ao adicionar tipo de pacote:', e);
      throw e;
    }
  };

  const updatePackageType = async (id, packageTypeData) => {
    try {
      await api.put(`/storage/package-types/${id}`, packageTypeData);
      await fetchPackageTypes();
    } catch (e) {
      console.error('Erro ao atualizar tipo de pacote:', e);
      throw e;
    }
  };

  const deletePackageType = async (id) => {
    try {
      await api.delete(`/storage/package-types/${id}`);
      await fetchPackageTypes();
    } catch (e) {
      console.error('Erro ao excluir tipo de pacote:', e);
      throw e;
    }
  };

  return {
    packageTypes,
    isLoading,
    error,
    fetchPackageTypes,
    addPackageType,
    updatePackageType,
    deletePackageType
  };
}
