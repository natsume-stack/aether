import { Select } from 'antd';

import type { SelectProps } from 'antd';

export type MapChoice = {
    value:string;
    name:string;
    permanentMapId:string;
    mode?:'play' | 'edit';
    suffix?:string;
};

/** Search and display always use the map name and immutable map ID. */
export function MapSelect({
    maps,
    grouped = false,
    ...props
}:Omit<SelectProps<string>, 'options'> & { maps:readonly MapChoice[]; grouped?:boolean }) {
    const option = (map:MapChoice) => ({
        value: map.value,
        selectedLabel: `${map.name} · ${map.permanentMapId}${map.suffix || ''}`,
        searchText: `${map.name} ${map.permanentMapId}`,
        label: (
            <div className="player-admin-map-option">
                <strong>{map.name}</strong>
                <span className="player-admin-muted">
                    地图 ID：<code>{map.permanentMapId}</code>
                    {map.suffix}
                </span>
            </div>
        ),
    });
    const options = grouped
        ? (['play', 'edit'] as const)
              .filter((mode) => maps.some((map) => map.mode === mode))
              .map((mode) => ({
                  label: mode === 'play' ? '游玩端' : '创作端',
                  options: maps.filter((map) => map.mode === mode).map(option),
              }))
        : maps.map(option);
    return (
        <Select<string>
            showSearch
            optionLabelProp="selectedLabel"
            filterOption={(input, item) =>
                String(item?.searchText || '')
                    .toLowerCase()
                    .includes(input.toLowerCase())
            }
            listHeight={400}
            virtual={false}
            dropdownClassName="player-admin-map-dropdown"
            {...props}
            options={options}
        />
    );
}
