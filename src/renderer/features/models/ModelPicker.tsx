import { useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Command, useCommandState } from 'cmdk';
import { Check, ChevronsUpDown, Search } from 'lucide-react';
import type { ModelOption } from '../../../shared/runtime';
import { Button } from '../../components/ui/button';

/** One model control: selection stays unchanged until an option is chosen. */
export function ModelPicker({
  models,
  label = '选择模型',
  selected,
  disabled,
  onSelect,
}: {
  models: ModelOption[];
  label?: string;
  selected?: ModelOption;
  disabled: boolean;
  onSelect: (model: ModelOption) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const selecting = useRef(false);
  async function choose(model: ModelOption) {
    if (disabled || selecting.current) return;
    selecting.current = true;
    try {
      await onSelect(model);
    } finally {
      selecting.current = false;
      setOpen(false);
    }
  }
  return (
    <div className="model-picker">
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <Button
            variant="outline"
            className="model-picker-trigger"
            aria-label={label}
            aria-description={selected ? `当前模型：${selected.name}` : '尚未选择模型'}
            disabled={disabled}
          >
            <span>{selected?.name ?? '选择模型'}</span>
            <ChevronsUpDown aria-hidden="true" />
          </Button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            className="model-picker-popover"
            align="start"
            sideOffset={6}
            collisionPadding={12}
            aria-label="模型选择器"
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              search.current?.focus();
            }}
          >
            <Command label="搜索模型" defaultValue={selected?.model}>
              <div className="model-picker-search">
                <Search size={16} aria-hidden="true" />
                <Command.Input
                  ref={search}
                  aria-label="搜索模型"
                  placeholder="搜索模型名称或 ID…"
                  disabled={disabled}
                />
              </div>
              <Command.List label="可用模型">
                <EmptyModels />
                {models.map((model) => (
                  <Command.Item
                    className="model-picker-option"
                    key={model.model}
                    value={model.model}
                    keywords={[model.name, model.provider]}
                    disabled={disabled}
                    onSelect={() => void choose(model)}
                  >
                    <Check
                      aria-hidden="true"
                      size={16}
                      className={
                        model.model === selected?.model
                          ? 'model-picker-check'
                          : 'model-picker-check invisible'
                      }
                    />
                    <span className="model-picker-option-text">
                      <span>{model.name}</span>
                      <small>{model.model}</small>
                    </span>
                    {model.reasoning && <small className="model-picker-capability">思考</small>}
                  </Command.Item>
                ))}
              </Command.List>
            </Command>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

function EmptyModels() {
  const empty = useCommandState((state) => state.filtered.count === 0);
  return empty ? (
    <div className="model-picker-empty" role="status">
      没有匹配的模型，请调整搜索条件。
    </div>
  ) : null;
}
