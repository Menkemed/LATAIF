// ═══════════════════════════════════════════════════════════
// LATAIF — Task List Page
// Full task management with filtering and CRUD
// ═══════════════════════════════════════════════════════════

import { useEffect, useState, useMemo } from 'react';
import {
  Plus, CheckCircle2, Trash2, Edit3, AlertTriangle,
  Zap,
} from 'lucide-react';
import { PageLayout } from '@/components/layout/PageLayout';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { StatusDot } from '@/components/ui/StatusDot';
import { useTaskStore } from '@/stores/taskStore';
import { matchesDeep } from '@/core/utils/deep-search';
import type { Task, TaskType, TaskPriority, TaskStatus, LinkedEntityType } from '@/core/models/types';

// ── Constants ──

const TASK_TYPES: { value: TaskType; label: string }[] = [
  { value: 'general', label: 'General' },
  { value: 'follow_up', label: 'Follow Up' },
  { value: 'review', label: 'Review' },
  { value: 'price_check', label: 'Price Check' },
  { value: 'reactivation', label: 'Reactivation' },
  { value: 'payment_reminder', label: 'Payment Reminder' },
  { value: 'repair_ready', label: 'Repair Ready' },
  { value: 'consignment_expiry', label: 'Consignment Expiry' },
  { value: 'agent_return', label: 'Agent Return' },
  { value: 'order_delivery', label: 'Order Delivery' },
];

const PRIORITIES: { value: TaskPriority; label: string; color: string }[] = [
  { value: 'urgent', label: 'Urgent', color: '#CC4444' },
  { value: 'high', label: 'High', color: '#CC8844' },
  { value: 'medium', label: 'Medium', color: '#0F0F10' },
  { value: 'low', label: 'Low', color: '#6B7280' },
];

const STATUS_OPTIONS: { value: TaskStatus | ''; label: string }[] = [
  { value: '', label: 'All Statuses' },
  { value: 'open', label: 'Open' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
];

const ENTITY_TYPES: { value: LinkedEntityType; label: string }[] = [
  { value: 'product', label: 'Product' },
  { value: 'customer', label: 'Customer' },
  { value: 'offer', label: 'Offer' },
  { value: 'invoice', label: 'Invoice' },
  { value: 'repair', label: 'Repair' },
  { value: 'consignment', label: 'Consignment' },
  { value: 'agent_transfer', label: 'Agent Transfer' },
  { value: 'order', label: 'Order' },
];

function getPriorityColor(p: TaskPriority): string {
  return PRIORITIES.find(pr => pr.value === p)?.color || '#6B7280';
}

function isOverdue(task: Task): boolean {
  if (!task.dueAt || task.status === 'completed' || task.status === 'cancelled') return false;
  return new Date(task.dueAt) < new Date();
}

function formatDate(iso?: string): string {
  if (!iso) return '--';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatRelative(iso?: string): string {
  if (!iso) return '';
  const diff = new Date(iso).getTime() - Date.now();
  const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return 'Due today';
  if (days === 1) return 'Due tomorrow';
  return `${days}d left`;
}

// ── Select Component ──

function Select({ value, onChange, options, style }: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  style?: React.CSSProperties;
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      style={{
        background: '#EFECE2',
        border: '1px solid #E5E1D6',
        borderRadius: 8,
        padding: '8px 12px',
        fontSize: 13,
        color: '#0F0F10',
        outline: 'none',
        cursor: 'pointer',
        appearance: 'none',
        WebkitAppearance: 'none',
        backgroundImage: `url("data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 10 6' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1L5 5L9 1' stroke='%236B6B73' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`,
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'right 10px center',
        paddingRight: 28,
        ...style,
      }}
    >
      {options.map(o => (
        <option key={o.value} value={o.value} style={{ background: '#FFFFFF', color: '#0F0F10' }}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

// ── Textarea ──

function Textarea({ label, value, onChange, rows = 3 }: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <div>
      {label && <label className="text-overline" style={{ marginBottom: 6, display: 'block' }}>{label}</label>}
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        rows={rows}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          width: '100%',
          background: 'transparent',
          borderBottom: `1px solid ${focused ? '#0F0F10' : '#D5D1C4'}`,
          padding: '10px 0',
          fontSize: 14,
          color: '#0F0F10',
          outline: 'none',
          resize: 'vertical',
          fontFamily: 'inherit',
        }}
      />
    </div>
  );
}

// ── Priority Badge ──

function PriorityBadge({ priority }: { priority: TaskPriority }) {
  const color = getPriorityColor(priority);
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      padding: '2px 10px',
      borderRadius: 100,
      fontSize: 11,
      fontWeight: 600,
      letterSpacing: '0.04em',
      textTransform: 'uppercase',
      color,
      background: `${color}14`,
      border: `1px solid ${color}30`,
    }}>
      {priority === 'urgent' && <AlertTriangle size={10} />}
      {priority}
    </span>
  );
}

// ── Task Form Modal ──

interface TaskFormData {
  title: string;
  description: string;
  type: TaskType;
  priority: TaskPriority;
  dueAt: string;
  linkedEntityType: string;
  linkedEntityId: string;
  notes: string;
}

const EMPTY_FORM: TaskFormData = {
  title: '',
  description: '',
  type: 'general',
  priority: 'medium',
  dueAt: '',
  linkedEntityType: '',
  linkedEntityId: '',
  notes: '',
};

function TaskFormModal({ open, onClose, task, onSave }: {
  open: boolean;
  onClose: () => void;
  task?: Task | null;
  onSave: (data: TaskFormData) => void;
}) {
  const [form, setForm] = useState<TaskFormData>(EMPTY_FORM);

  useEffect(() => {
    if (open) {
      if (task) {
        setForm({
          title: task.title,
          description: task.description || '',
          type: task.type,
          priority: task.priority,
          dueAt: task.dueAt ? task.dueAt.split('T')[0] : '',
          linkedEntityType: task.linkedEntityType || '',
          linkedEntityId: task.linkedEntityId || '',
          notes: '',
        });
      } else {
        setForm(EMPTY_FORM);
      }
    }
  }, [open, task]);

  const set = (key: keyof TaskFormData, val: string) => setForm(prev => ({ ...prev, [key]: val }));

  return (
    <Modal open={open} onClose={onClose} title={task ? 'Edit Task' : 'New Task'} width={560}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <Input
          label="TITLE"
          value={form.title}
          onChange={e => set('title', e.target.value)}
          placeholder="Task title..."
        />

        <Textarea
          label="DESCRIPTION"
          value={form.description}
          onChange={v => set('description', v)}
        />

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div>
            <label className="text-overline" style={{ marginBottom: 6, display: 'block' }}>TYPE</label>
            <Select
              value={form.type}
              onChange={v => set('type', v)}
              options={TASK_TYPES.map(t => ({ value: t.value, label: t.label }))}
              style={{ width: '100%' }}
            />
          </div>
          <div>
            <label className="text-overline" style={{ marginBottom: 6, display: 'block' }}>PRIORITY</label>
            <Select
              value={form.priority}
              onChange={v => set('priority', v)}
              options={PRIORITIES.map(p => ({ value: p.value, label: p.label }))}
              style={{ width: '100%' }}
            />
          </div>
        </div>

        <Input
          label="DUE DATE"
          type="date"
          value={form.dueAt}
          onChange={e => set('dueAt', e.target.value)}
        />

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div>
            <label className="text-overline" style={{ marginBottom: 6, display: 'block' }}>LINKED ENTITY TYPE</label>
            <Select
              value={form.linkedEntityType}
              onChange={v => set('linkedEntityType', v)}
              options={[{ value: '', label: 'None' }, ...ENTITY_TYPES.map(e => ({ value: e.value, label: e.label }))]}
              style={{ width: '100%' }}
            />
          </div>
          <div>
            <Input
              label="ENTITY ID"
              value={form.linkedEntityId}
              onChange={e => set('linkedEntityId', e.target.value)}
              placeholder="ID..."
            />
          </div>
        </div>

        <Textarea
          label="NOTES"
          value={form.notes}
          onChange={v => set('notes', v)}
          rows={2}
        />

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 8 }}>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => { onSave(form); onClose(); }}
            disabled={!form.title.trim()}
          >
            {task ? 'Save Changes' : 'Create Task'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ── Main Component ──

export function TaskList() {
  const { tasks, loadTasks, createTask, updateTask, completeTask, deleteTask } = useTaskStore();

  const [filterStatus, setFilterStatus] = useState<TaskStatus | ''>('');
  const [filterPriority, setFilterPriority] = useState<TaskPriority | ''>('');
  const [filterType, setFilterType] = useState<TaskType | ''>('');
  const [searchQuery, setSearchQuery] = useState('');

  const [modalOpen, setModalOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  const filtered = useMemo(() => {
    let list = [...tasks];
    if (filterStatus) list = list.filter(t => t.status === filterStatus);
    if (filterPriority) list = list.filter(t => t.priority === filterPriority);
    if (filterType) list = list.filter(t => t.type === filterType);
    if (searchQuery.trim()) {
      list = list.filter(t => matchesDeep(t, searchQuery));
    }
    return list;
  }, [tasks, filterStatus, filterPriority, filterType, searchQuery]);

  const counts = useMemo(() => ({
    total: tasks.length,
    open: tasks.filter(t => t.status === 'open').length,
    inProgress: tasks.filter(t => t.status === 'in_progress').length,
    completed: tasks.filter(t => t.status === 'completed').length,
    overdue: tasks.filter(isOverdue).length,
  }), [tasks]);

  const handleSave = (form: TaskFormData) => {
    if (editingTask) {
      updateTask(editingTask.id, {
        title: form.title,
        description: form.description || undefined,
        type: form.type as TaskType,
        priority: form.priority as TaskPriority,
        dueAt: form.dueAt ? new Date(form.dueAt).toISOString() : undefined,
        linkedEntityType: (form.linkedEntityType as LinkedEntityType) || undefined,
        linkedEntityId: form.linkedEntityId || undefined,
      });
    } else {
      createTask({
        title: form.title,
        description: form.description || undefined,
        type: form.type as TaskType,
        priority: form.priority as TaskPriority,
        dueAt: form.dueAt ? new Date(form.dueAt).toISOString() : undefined,
        linkedEntityType: (form.linkedEntityType as LinkedEntityType) || undefined,
        linkedEntityId: form.linkedEntityId || undefined,
        notes: form.notes || undefined,
      });
    }
    setEditingTask(null);
  };

  const openNew = () => { setEditingTask(null); setModalOpen(true); };
  const openEdit = (task: Task) => { setEditingTask(task); setModalOpen(true); };

  return (
    <PageLayout
      title="Tasks"
      subtitle={`${counts.total} total \u00b7 ${counts.open} open \u00b7 ${counts.overdue} overdue`}
      showSearch
      onSearch={setSearchQuery}
      searchPlaceholder="Search tasks..."
      actions={
        <Button variant="primary" icon={<Plus size={16} />} onClick={openNew}>
          New Task
        </Button>
      }
    >
      {/* Summary Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 32 }}>
        {[
          { label: 'Open', value: counts.open, color: '#6E8AAA' },
          { label: 'In Progress', value: counts.inProgress, color: '#0F0F10' },
          { label: 'Completed', value: counts.completed, color: '#7EAA6E' },
          { label: 'Overdue', value: counts.overdue, color: '#AA6E6E' },
        ].map(s => (
          <Card key={s.label}>
            <div style={{ fontSize: 11, color: '#6B7280', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 8 }}>
              {s.label}
            </div>
            <div style={{ fontSize: 28, fontWeight: 300, color: s.color, letterSpacing: '-0.02em' }}>
              {s.value}
            </div>
          </Card>
        ))}
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
        <Select
          value={filterStatus}
          onChange={v => setFilterStatus(v as TaskStatus | '')}
          options={STATUS_OPTIONS}
        />
        <Select
          value={filterPriority}
          onChange={v => setFilterPriority(v as TaskPriority | '')}
          options={[{ value: '', label: 'All Priorities' }, ...PRIORITIES.map(p => ({ value: p.value, label: p.label }))]}
        />
        <Select
          value={filterType}
          onChange={v => setFilterType(v as TaskType | '')}
          options={[{ value: '', label: 'All Types' }, ...TASK_TYPES.map(t => ({ value: t.value, label: t.label }))]}
        />
        {(filterStatus || filterPriority || filterType) && (
          <Button
            variant="ghost"
            onClick={() => { setFilterStatus(''); setFilterPriority(''); setFilterType(''); }}
            style={{ minWidth: 'auto', padding: '8px 16px' }}
          >
            Clear Filters
          </Button>
        )}
      </div>

      {/* Task List */}
      <Card noPadding>
        {/* Header */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 100px 100px 120px 120px 120px',
            padding: '12px 24px',
            borderBottom: '1px solid #E5E1D6',
            fontSize: 11,
            color: '#6B7280',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
          }}
        >
          <span>Task</span>
          <span>Priority</span>
          <span>Type</span>
          <span>Due</span>
          <span>Status</span>
          <span style={{ textAlign: 'right' }}>Actions</span>
        </div>

        {/* Rows */}
        {filtered.length === 0 ? (
          <div style={{ padding: '48px 24px', textAlign: 'center', color: '#6B7280', fontSize: 14 }}>
            {tasks.length === 0
              ? 'No tasks yet. Create one or let automations generate them.'
              : 'No tasks match the current filters.'}
          </div>
        ) : (
          filtered.map(task => {
            const overdue = isOverdue(task);
            return (
              <TaskRow
                key={task.id}
                task={task}
                overdue={overdue}
                onEdit={() => openEdit(task)}
                onComplete={() => completeTask(task.id)}
                onDelete={() => deleteTask(task.id)}
              />
            );
          })
        )}
      </Card>

      {/* Modal */}
      <TaskFormModal
        open={modalOpen}
        onClose={() => { setModalOpen(false); setEditingTask(null); }}
        task={editingTask}
        onSave={handleSave}
      />
    </PageLayout>
  );
}

// ── Task Row ──

function TaskRow({ task, overdue, onEdit, onComplete, onDelete }: {
  task: Task;
  overdue: boolean;
  onEdit: () => void;
  onComplete: () => void;
  onDelete: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const isCompleted = task.status === 'completed' || task.status === 'cancelled';

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 100px 100px 120px 120px 120px',
        padding: '14px 24px',
        borderBottom: '1px solid #E5E1D6',
        alignItems: 'center',
        background: hovered ? 'rgba(255,255,255,0.015)' : overdue ? 'rgba(170,110,110,0.04)' : 'transparent',
        transition: 'background 0.2s',
        opacity: isCompleted ? 0.5 : 1,
      }}
    >
      {/* Title + meta */}
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              fontSize: 14,
              color: '#0F0F10',
              fontWeight: 500,
              textDecoration: isCompleted ? 'line-through' : 'none',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {task.title}
          </span>
          {task.autoGenerated && (
            <Zap size={12} style={{ color: '#0F0F10', flexShrink: 0 }} />
          )}
          {overdue && (
            <AlertTriangle size={12} style={{ color: '#AA6E6E', flexShrink: 0 }} />
          )}
        </div>
        {task.linkedEntityType && (
          <span style={{ fontSize: 11, color: '#6B7280', marginTop: 2, display: 'block' }}>
            {task.linkedEntityType.replace(/_/g, ' ')} {task.linkedEntityId ? `#${task.linkedEntityId.slice(0, 8)}` : ''}
          </span>
        )}
      </div>

      {/* Priority */}
      <div>
        <PriorityBadge priority={task.priority} />
      </div>

      {/* Type */}
      <div style={{ fontSize: 12, color: '#4B5563' }}>
        {task.type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
      </div>

      {/* Due */}
      <div>
        <div style={{ fontSize: 13, color: overdue ? '#AA6E6E' : '#0F0F10' }}>
          {formatDate(task.dueAt)}
        </div>
        {task.dueAt && !isCompleted && (
          <div style={{ fontSize: 11, color: overdue ? '#AA6E6E' : '#6B7280', marginTop: 1 }}>
            {formatRelative(task.dueAt)}
          </div>
        )}
      </div>

      {/* Status */}
      <div>
        <StatusDot status={task.status} />
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, opacity: hovered ? 1 : 0, transition: 'opacity 0.2s' }}>
        {!isCompleted && (
          <button
            onClick={onComplete}
            title="Complete"
            style={{
              background: 'none',
              border: 'none',
              padding: 6,
              cursor: 'pointer',
              color: '#7EAA6E',
              borderRadius: 4,
            }}
            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(126,170,110,0.1)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'none')}
          >
            <CheckCircle2 size={15} />
          </button>
        )}
        <button
          onClick={onEdit}
          title="Edit"
          style={{
            background: 'none',
            border: 'none',
            padding: 6,
            cursor: 'pointer',
            color: '#6E8AAA',
            borderRadius: 4,
          }}
          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(110,138,170,0.1)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'none')}
        >
          <Edit3 size={15} />
        </button>
        <button
          onClick={onDelete}
          title="Delete"
          style={{
            background: 'none',
            border: 'none',
            padding: 6,
            cursor: 'pointer',
            color: '#AA6E6E',
            borderRadius: 4,
          }}
          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(170,110,110,0.1)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'none')}
        >
          <Trash2 size={15} />
        </button>
      </div>
    </div>
  );
}
