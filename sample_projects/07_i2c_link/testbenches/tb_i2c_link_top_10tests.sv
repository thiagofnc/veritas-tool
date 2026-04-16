`timescale 1ns/1ps

module tb_i2c_link_top_10tests;
    reg clk = 0;
    reg rst = 1;

    // DUT0 controls
    reg  start0 = 0;
    reg  [7:0] tx0 = 8'h00;
    wire busy0, done0, ack_error0;
    wire [7:0] rx0;
    wire rxv0;

    // DUT1 controls (mismatched slave address)
    reg  start1 = 0;
    reg  [7:0] tx1 = 8'h00;
    wire busy1, done1, ack_error1;
    wire [7:0] rx1;
    wire rxv1;

    wire scl0, sda0, scl1, sda1;

    i2c_link_top #(
        .CLK_DIV(4),
        .SLAVE_ADDRESS(7'h42)
    ) dut_ok (
        .clk(clk),
        .rst(rst),
        .start_write(start0),
        .tx_data(tx0),
        .busy(busy0),
        .done(done0),
        .ack_error(ack_error0),
        .slave_rx_data(rx0),
        .slave_rx_valid(rxv0),
        .i2c_scl(scl0),
        .i2c_sda(sda0)
    );

    i2c_link_top #(
        .CLK_DIV(4),
        .SLAVE_ADDRESS(7'h43)
    ) dut_badaddr (
        .clk(clk),
        .rst(rst),
        .start_write(start1),
        .tx_data(tx1),
        .busy(busy1),
        .done(done1),
        .ack_error(ack_error1),
        .slave_rx_data(rx1),
        .slave_rx_valid(rxv1),
        .i2c_scl(scl1),
        .i2c_sda(sda1)
    );

    always #5 clk = ~clk;

    task automatic pulse_start0;
        begin
            @(negedge clk);
            start0 <= 1'b1;
            @(negedge clk);
            start0 <= 1'b0;
        end
    endtask

    task automatic pulse_start1;
        begin
            @(negedge clk);
            start1 <= 1'b1;
            @(negedge clk);
            start1 <= 1'b0;
        end
    endtask

    task automatic wait_busy_rise;
        input busy;
        input [1023:0] label;
        output ok;
        integer i;
        begin
            ok = 1'b0;
            for (i = 0; i < 500; i = i + 1) begin
                @(posedge clk);
                if (busy) begin
                    ok = 1'b1;
                    disable wait_busy_rise;
                end
            end
            $display("FAIL [t=%0t] %0s: busy never asserted", $time, label);
        end
    endtask

    task automatic wait_done;
        input done;
        input [1023:0] label;
        output ok;
        integer i;
        begin
            ok = 1'b0;
            for (i = 0; i < 500; i = i + 1) begin
                @(posedge clk);
                if (done) begin
                    ok = 1'b1;
                    disable wait_done;
                end
            end
            $display("FAIL [t=%0t] %0s: done never asserted", $time, label);
        end
    endtask

    task automatic check_done_one_pulse;
        input done;
        input [1023:0] label;
        begin
            @(posedge clk);
            if (done) $display("FAIL [t=%0t] %0s: done not 1-cycle pulse", $time, label);
            else      $display("PASS [t=%0t] %0s", $time, label);
        end
    endtask

    task automatic do_write_ok;
        input [7:0] data;
        input [1023:0] label;
        reg ok_busy;
        reg ok_done;
        begin
            tx0 <= data;
            pulse_start0();
            wait_busy_rise(busy0, {label, ": busy"}, ok_busy);
            wait_done(done0, {label, ": done"}, ok_done);

            if (ok_busy && ok_done) begin
                @(posedge clk);
                if (ack_error0) begin
                    $display("FAIL [t=%0t] %0s: ack_error asserted", $time, label);
                end else if (!rxv0) begin
                    $display("FAIL [t=%0t] %0s: slave_rx_valid not asserted", $time, label);
                end else if (rx0 !== data) begin
                    $display("FAIL [t=%0t] %0s: rx mismatch exp=0x%0h got=0x%0h", $time, label, data, rx0);
                end else begin
                    $display("PASS [t=%0t] %0s", $time, label);
                end
            end
            repeat (10) @(posedge clk);
        end
    endtask

    initial begin
        $dumpfile("tb_i2c_link_top_10tests.vcd");
        $dumpvars(0, tb_i2c_link_top_10tests);

        rst = 1'b1;
        start0 = 1'b0; start1 = 1'b0;
        tx0 = 8'h00; tx1 = 8'h00;
        #50 rst = 1'b0;

        // TEST 1: write 0x00 (all zeros)
        do_write_ok(8'h00, "TEST1 all-zeros payload");

        // TEST 2: write 0xFF (all ones)
        do_write_ok(8'hFF, "TEST2 all-ones payload");

        // TEST 3: alternating pattern 0xAA
        do_write_ok(8'hAA, "TEST3 alternating 0xAA");

        // TEST 4: alternating pattern 0x55
        do_write_ok(8'h55, "TEST4 alternating 0x55");

        // TEST 5: start held high for multiple cycles
        begin
            reg ok_busy;
            reg ok_done;
            tx0 <= 8'h3C;
            @(negedge clk);
            start0 <= 1'b1;
            repeat (5) @(negedge clk);
            start0 <= 1'b0;
            wait_busy_rise(busy0, "TEST5 busy", ok_busy);
            wait_done(done0, "TEST5 done", ok_done);
            if (ok_busy && ok_done && !ack_error0 && rxv0 && rx0 === 8'h3C)
                $display("PASS [t=%0t] TEST5 start held high (multi-cycle)", $time);
            else if (ok_busy && ok_done)
                $display("FAIL [t=%0t] TEST5 start held high: bad completion ack_error=%0b rxv=%0b rx=0x%0h", $time, ack_error0, rxv0, rx0);
            repeat (10) @(posedge clk);
        end

        // TEST 6: assert start again while busy
        begin
            reg ok_busy;
            reg ok_done;
            tx0 <= 8'hC3;
            pulse_start0();
            wait_busy_rise(busy0, "TEST6 busy", ok_busy);
            repeat (3) @(negedge clk);
            start0 <= 1'b1;
            @(negedge clk);
            start0 <= 1'b0;
            wait_done(done0, "TEST6 done", ok_done);
            if (ok_busy && ok_done && !ack_error0 && rxv0 && rx0 === 8'hC3)
                $display("PASS [t=%0t] TEST6 start during busy ignored", $time);
            else if (ok_busy && ok_done)
                $display("FAIL [t=%0t] TEST6 start during busy: bad completion", $time);
            repeat (10) @(posedge clk);
        end

        // TEST 7: back-to-back transactions
        begin
            reg ok_done_a;
            reg ok_done_b;
            tx0 <= 8'h12;
            pulse_start0();
            wait_done(done0, "TEST7a done", ok_done_a);
            @(posedge clk);
            tx0 <= 8'h34;
            pulse_start0();
            wait_done(done0, "TEST7b done", ok_done_b);
            if (ok_done_a && ok_done_b && rx0 === 8'h34)
                $display("PASS [t=%0t] TEST7 back-to-back writes", $time);
            else if (ok_done_a && ok_done_b)
                $display("FAIL [t=%0t] TEST7 back-to-back: rx mismatch exp=0x34 got=0x%0h", $time, rx0);
            repeat (10) @(posedge clk);
        end

        // TEST 8: done is 1-cycle pulse
        begin
            reg ok_done;
            tx0 <= 8'h5A;
            pulse_start0();
            wait_done(done0, "TEST8 done detect", ok_done);
            if (ok_done) check_done_one_pulse(done0, "TEST8 done one-cycle");
            repeat (10) @(posedge clk);
        end

        // TEST 9: bad address should NACK and set ack_error
        begin
            reg ok_busy;
            reg ok_done;
            tx1 <= 8'hBE;
            pulse_start1();
            wait_busy_rise(busy1, "TEST9 busy", ok_busy);
            wait_done(done1, "TEST9 done", ok_done);
            @(posedge clk);
            if (ok_busy && ok_done && ack_error1 && !rxv1)
                $display("PASS [t=%0t] TEST9 bad address -> NACK/ack_error", $time);
            else if (ok_busy && ok_done && !ack_error1)
                $display("FAIL [t=%0t] TEST9 bad address: ack_error not asserted", $time);
            else if (ok_busy && ok_done && rxv1)
                $display("FAIL [t=%0t] TEST9 bad address: slave_rx_valid unexpectedly asserted", $time);
            repeat (10) @(posedge clk);
        end

        // TEST 10: reset mid-transaction and then transact again
        begin
            reg ok_busy;
            tx0 <= 8'h77;
            pulse_start0();
            wait_busy_rise(busy0, "TEST10 busy", ok_busy);
            repeat (10) @(posedge clk);
            rst <= 1'b1;
            repeat (2) @(posedge clk);
            if (ok_busy && busy0 !== 1'b0)
                $display("FAIL [t=%0t] TEST10 mid-reset: busy not low during reset", $time);
            else if (ok_busy)
                $display("PASS [t=%0t] TEST10 mid-transaction reset drives busy low", $time);
            rst <= 1'b0;
            repeat (5) @(posedge clk);
            do_write_ok(8'h88, "TEST10b post-reset transaction");
        end

        #200;
        $finish;
    end
endmodule
