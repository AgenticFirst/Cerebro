import { useRoutines } from '../../context/RoutineContext';
import RoutineList from './routines/RoutineList';
import RoutineEditor from './routines/RoutineEditor';

export default function RoutinesScreen() {
  const { editingRoutineId, routines } = useRoutines();

  const editingRoutine = editingRoutineId
    ? (routines.find((r) => r.id === editingRoutineId) ?? null)
    : null;

  if (editingRoutine) {
    return <RoutineEditor routine={editingRoutine} />;
  }

  return <RoutineList />;
}
