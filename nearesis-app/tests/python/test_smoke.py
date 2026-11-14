import duckdb
import pyarrow as pa


def test_duckdb_reads_arrow_table():
    table = pa.table({"amount": ["1.50", "2.25"]})
    con = duckdb.connect()
    con.register("t", table)
    assert con.execute("select count(*) from t").fetchone() == (2,)
