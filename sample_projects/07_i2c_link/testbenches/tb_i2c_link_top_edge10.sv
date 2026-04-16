`timescale 1ns/1ps

module tb_i2c_link_top_edge10;
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

  always #5 clk = ~clk;

  task automatic pulse_start;
    input integer cycles_high;
    begin
      @(negedge clk);
      start_write <= 1'b1;
      repeat (cycles_high-1) @(negedge clk);
      start_write <= 1'b0;
    end
  endtask

  task automatic wait_done_bounded;
    input integer max_cycles;
    input string label;
    output bit ok;
    integer i;
    begin
      ok = 0;
      for (i=0;i<max_cycles;i++) begin
        @(posedge clk);
        if (done) begin ok = 1; disable wait_done_bounded; end
      end
      $display("FAIL [t=%0t] %s: done timeout", $time, label);
    end
  endtask

  task automatic do_write_check;
    input [7:0] data;
    input string label;
    begin
      bit ok;
      @(negedge clk);
      tx_data <= data;
      pulse_start(1);
      wait_done_bounded(2000, label, ok);
      if (ok) begin
        @(posedge clk);
        if (ack_error) $display("FAIL [t=%0t] %s: ack_error", $time, label);
        else if (!slave_rx_valid) $display("FAIL [t=%0t] %s: slave_rx_valid low", $time, label);
        else if (slave_rx_data !== data) $display("FAIL [t=%0t] %s: rx mismatch exp=%0h got=%0h", $time, label, data, slave_rx_data);
        else $display("PASS [t=%0t] %s", $time, label);
      end
      // ensure done drops after 1 cycle
      @(posedge clk);
      if (done) $display("FAIL [t=%0t] %s: done not 1-cycle", $time, label);
      repeat(10) @(posedge clk);
    end
  endtask

  initial begin
    $dumpfile("tb_i2c_link_top_edge10.vcd");
    $dumpvars(0, tb_i2c_link_top_edge10);

    // reset
    rst = 1;
    repeat (5) @(posedge clk);
    rst = 0;
    repeat (5) @(posedge clk);

    // TEST1: all zeros
    do_write_check(8'h00, "TEST1 write 0x00");

    // TEST2: all ones
    do_write_check(8'hFF, "TEST2 write 0xFF");

    // TEST3: alternating AA
    do_write_check(8'hAA, "TEST3 write 0xAA");

    // TEST4: alternating 55
    do_write_check(8'h55, "TEST4 write 0x55");

    // TEST5: start_write held high 3 cycles should still do exactly 1 transaction
    begin
      bit ok;
      integer done_pulses;
      tx_data <= 8'hC3;
      done_pulses = 0;
      fork
        begin : count_done
          forever begin
            @(posedge clk);
            if (done) done_pulses++;
          end
        end
      join_none

      pulse_start(3);
      wait_done_bounded(2000, "TEST5 held-high start", ok);
      disable count_done;
      if (ok) begin
        @(posedge clk);
        if (done_pulses != 1)
          $display("FAIL [t=%0t] TEST5 held-high start: done_pulses=%0d", $time, done_pulses);
        else if (slave_rx_data !== 8'hC3)
          $display("FAIL [t=%0t] TEST5 held-high start: rx mismatch", $time);
        else
          $display("PASS [t=%0t] TEST5 held-high start triggers single transaction", $time);
      end
      repeat (10) @(posedge clk);
    end

    // TEST6: start_write asserted while busy should be ignored (no extra done)
    begin
      bit ok;
      integer done_pulses;
      done_pulses = 0;
      fork
        begin : count_done2
          forever begin
            @(posedge clk);
            if (done) done_pulses++;
          end
        end
      join_none

      tx_data <= 8'hF1;
      pulse_start(1);
      // wait until busy then attempt another start
      wait (busy);
      tx_data <= 8'hF2;
      pulse_start(1);

      wait_done_bounded(2000, "TEST6 start during busy", ok);
      // allow some time for any erroneous second completion
      repeat (200) @(posedge clk);
      disable count_done2;

      if (!ok) ;
      else if (done_pulses != 1)
        $display("FAIL [t=%0t] TEST6: expected 1 done, got %0d", $time, done_pulses);
      else if (slave_rx_data !== 8'hF1)
        $display("FAIL [t=%0t] TEST6: rx changed/incorrect exp=F1 got=%0h", $time, slave_rx_data);
      else
        $display("PASS [t=%0t] TEST6 start during busy ignored", $time);

      repeat (10) @(posedge clk);
    end

    // TEST7: back-to-back with minimal idle (start on cycle immediately after done)
    begin
      bit ok;
      tx_data <= 8'h12;
      pulse_start(1);
      wait_done_bounded(2000, "TEST7a back-to-back first", ok);
      if (ok) begin
        @(negedge clk);
        tx_data <= 8'h34;
        start_write <= 1'b1;
        @(negedge clk);
        start_write <= 1'b0;
        wait_done_bounded(2000, "TEST7b back-to-back second", ok);
        if (ok && slave_rx_data === 8'h34) $display("PASS [t=%0t] TEST7 back-to-back writes", $time);
        else if (ok) $display("FAIL [t=%0t] TEST7: rx mismatch exp=34 got=%0h", $time, slave_rx_data);
      end
      repeat(10) @(posedge clk);
    end

    // TEST8: done must be exactly one clk wide for a normal transaction
    begin
      bit ok;
      integer done_width;
      tx_data <= 8'h5A;
      pulse_start(1);
      wait_done_bounded(2000, "TEST8 done width", ok);
      done_width = 0;
      if (ok) begin
        while (done) begin
          done_width++;
          @(posedge clk);
        end
        if (done_width == 1) $display("PASS [t=%0t] TEST8 done is 1-cycle pulse", $time);
        else $display("FAIL [t=%0t] TEST8 done width=%0d", $time, done_width);
      end
      repeat(10) @(posedge clk);
    end

    // TEST9: reset idle behavior: outputs low/known, not busy/done
    begin
      rst <= 1;
      repeat(2) @(posedge clk);
      if (busy !== 1'b0) $display("FAIL [t=%0t] TEST9: busy not 0 during reset", $time);
      else if (done !== 1'b0) $display("FAIL [t=%0t] TEST9: done not 0 during reset", $time);
      else if (ack_error !== 1'b0) $display("FAIL [t=%0t] TEST9: ack_error not 0 during reset", $time);
      else $display("PASS [t=%0t] TEST9 reset drives status low", $time);
      rst <= 0;
      repeat(5) @(posedge clk);
    end

    // TEST10: mid-transaction reset recovery (no hang, next transaction succeeds)
    begin
      bit ok;
      tx_data <= 8'h77;
      pulse_start(1);
      wait (busy);
      repeat(10) @(posedge clk);
      rst <= 1;
      repeat(2) @(posedge clk);
      if (busy !== 1'b0) $display("FAIL [t=%0t] TEST10: busy not low during reset", $time);
      else $display("PASS [t=%0t] TEST10 reset aborts transaction", $time);
      rst <= 0;
      repeat(10) @(posedge clk);
      do_write_check(8'h88, "TEST10b post-reset transaction");
    end

    #200;
    $finish;
  end
endmodule
