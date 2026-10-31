import { Pagination } from 'antd';

export const adminPaginationDefaults = {
    showSizeChanger: true,
    pageSizeOptions: ['20', '30', '50', '100'],
};

type Props = {
    page:number;
    pageSize:number;
    total:number;
    setPage:(page:number) => void;
    setPageSize:(size:number) => void;
};

/** Server-paged lists share size choices and return to page one after a size change. */
export function AdminPagination({ page, pageSize, total, setPage, setPageSize }:Props) {
    return (
        <div className="player-admin-table-pagination">
            <Pagination
                current={page}
                total={total}
                pageSize={pageSize}
                {...adminPaginationDefaults}
                onChange={(next, size) => {
                    if (size !== pageSize) {
                        setPageSize(size);
                        setPage(1);
                    } else {
                        setPage(next);
                    }
                }}
            />
        </div>
    );
}
