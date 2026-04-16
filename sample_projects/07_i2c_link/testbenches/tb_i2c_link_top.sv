`timescale 1ns/1ps

module tb_i2c_link_top;
    reg clk = 0;
    reg rst = 1;
    reg start_write = 0;
    reg [7:0] tx_data = 8'h00;
    wire busy;
    wire done;
    wire ack_error;
    wire [7:0] slave_rx_data;
    wire slave_rx_valid;
    wire i2c_scl;
    wire i2c_sda;

    i2c_link_top #(
        .CLK_DIV(4),
        .SLAVE_ADDRESS(7'h42)
    ) dut (
        .clk(clk),
        .rst(rst),
        .start_write(start_write),
        .tx_data(tx_data),
        .busy(busy),
        .done(done),
        .ack_error(ack_error),
        .slave_rx_data(slave_rx_data),
        .slave_rx_valid(slave_rx_valid),
        .i2c_scl(i2c_scl),
        .i2c_sda(i2c_sda)
    );

    always #5 clk = ~clk; // 100 MHz

    // Start a single write transaction and check that the slave receives the byte
    task automatic do_write_and_check(input [7:0] data, input string label);
        begin
            // initiate write
            @(negedge clk);
            tx_data <= data;
            start_write <= 1'b1;
            @(negedge clk);
            start_write <= 1'b0;

            // busy should assert shortly after start
            fork
                begin : busy_watch
                    integer i;
                    for (i = 0; i < 50; i = i + 1) begin
                        @(posedge clk);
                        if (busy) disable busy_watch;
                    end
                    $display("FAIL [t=%0t] %s: busy never asserted", $time, label);
                end
            join

            // wait for completion
            wait(done);
            @(posedge clk);

            if (ack_error) begin
                $display("FAIL [t=%0t] %s: ack_error set when communicating with matching slave", $time, label);
            end else if (!slave_rx_valid) begin
                $display("FAIL [t=%0t] %s: slave_rx_valid not asserted", $time, label);
            end else if (slave_rx_data !== data) begin
                $display("FAIL [t=%0t] %s: slave_rx_data mismatch: expected 0x%0h got 0x%0h", $time, label, data, slave_rx_data);
            end else begin
                $display("PASS [t=%0t] %s", $time, label);
            end

            // done should be a pulse; ensure it deasserts next cycle
            @(posedge clk);
            if (done) begin
                $display("FAIL [t=%0t] %s: done did not deassert after 1 cycle", $time, label);
            end

            // allow some idle time before next transaction
            repeat (10) @(posedge clk);
        end
    endtask

    initial begin
        $dumpfile("tb_i2c_link_top.vcd");
        $dumpvars(0, tb_i2c_link_top);

        // reset
        #0 rst = 1;
        #50 rst = 0;

        // TEST 1: basic write transaction
        do_write_and_check(8'hA5, "basic write transaction and slave reception");

        // TEST 2: second transaction with different data (checks repeatability)
        do_write_and_check(8'h3C, "second write transaction (repeatability)");

        // TEST 3: back-to-back transactions (start second immediately after first done)
        do_write_and_check(8'hF0, "third write transaction");
        do_write_and_check(8'h0F, "fourth write transaction immediately after third");

        // TEST 4: verify busy returns low after completion
        if (busy) begin
            $display("FAIL [t=%0t] busy stuck high after transactions", $time);
        end else begin
            $display("PASS [t=%0t] busy returns low after completion", $time);
        end

        #200;
        $finish;
    end
endmodule
