`timescale 1ns/1ps

module tb_i2c_link_top_3slaves_edge;
  reg clk = 0;
  reg rst = 1;
  reg start_write = 0;
  reg [1:0] slave_sel = 0;
  reg [7:0] tx_data = 8'h00;

  wire busy, done, ack_error;
  wire [7:0] slave_rx_data;
  wire slave_rx_valid;
  wire [7:0] slave0_rx_data, slave1_rx_data, slave2_rx_data;
  wire slave0_rx_valid, slave1_rx_valid, slave2_rx_valid;
  wire i2c_scl, i2c_sda;

  i2c_link_top #(
    .CLK_DIV(4),
    .SLAVE_ADDRESS(7'h42),
    .SLAVE1_ADDRESS(7'h43),
    .SLAVE2_ADDRESS(7'h44)
  ) dut (
    .clk(clk),
    .rst(rst),
    .start_write(start_write),
    .slave_sel(slave_sel),
    .tx_data(tx_data),
    .busy(busy),
    .done(done),
    .ack_error(ack_error),
    .slave_rx_data(slave_rx_data),
    .slave_rx_valid(slave_rx_valid),
    .slave0_rx_data(slave0_rx_data),
    .slave0_rx_valid(slave0_rx_valid),
    .slave1_rx_data(slave1_rx_data),
    .slave1_rx_valid(slave1_rx_valid),
    .slave2_rx_data(slave2_rx_data),
    .slave2_rx_valid(slave2_rx_valid),
    .i2c_scl(i2c_scl),
    .i2c_sda(i2c_sda)
  );

  always #5 clk = ~clk;

  initial begin
    $dumpfile("tb_i2c_link_top_3slaves_edge.vcd");
    $dumpvars(0, tb_i2c_link_top_3slaves_edge);
  end

  task automatic pulse_start(input integer cycles_high);
    begin
      @(negedge clk);
      start_write <= 1'b1;
      repeat (cycles_high-1) @(negedge clk);
      start_write <= 1'b0;
    end
  endtask

  task automatic wait_done_bounded(input integer max_cycles, input [1023:0] label, output reg ok);
    integer i;
    begin
      ok = 1'b0;
      for (i=0;i<max_cycles;i=i+1) begin
        @(posedge clk);
        if (done) begin ok = 1'b1; disable wait_done_bounded; end
      end
      $display("FAIL [t=%0t] %0s: done timeout", $time, label);
    end
  endtask

  task automatic check_target(input [1:0] sel, input [7:0] data, input [1023:0] label);
    begin
      if (ack_error) $display("FAIL [t=%0t] %0s: ack_error", $time, label);
      else if (sel==2'd0) begin
        if (!slave0_rx_valid) $display("FAIL [t=%0t] %0s: s0 valid low", $time, label);
        else if (slave0_rx_data !== data) $display("FAIL [t=%0t] %0s: s0 data got=%0h exp=%0h", $time, label, slave0_rx_data, data);
        else if (slave1_rx_valid || slave2_rx_valid) $display("FAIL [t=%0t] %0s: other valid high (s1=%b s2=%b)", $time, label, slave1_rx_valid, slave2_rx_valid);
        else $display("PASS [t=%0t] %0s", $time, label);
      end else if (sel==2'd1) begin
        if (!slave1_rx_valid) $display("FAIL [t=%0t] %0s: s1 valid low", $time, label);
        else if (slave1_rx_data !== data) $display("FAIL [t=%0t] %0s: s1 data got=%0h exp=%0h", $time, label, slave1_rx_data, data);
        else if (slave0_rx_valid || slave2_rx_valid) $display("FAIL [t=%0t] %0s: other valid high (s0=%b s2=%b)", $time, label, slave0_rx_valid, slave2_rx_valid);
        else $display("PASS [t=%0t] %0s", $time, label);
      end else if (sel==2'd2) begin
        if (!slave2_rx_valid) $display("FAIL [t=%0t] %0s: s2 valid low", $time, label);
        else if (slave2_rx_data !== data) $display("FAIL [t=%0t] %0s: s2 data got=%0h exp=%0h", $time, label, slave2_rx_data, data);
        else if (slave0_rx_valid || slave1_rx_valid) $display("FAIL [t=%0t] %0s: other valid high (s0=%b s1=%b)", $time, label, slave0_rx_valid, slave1_rx_valid);
        else $display("PASS [t=%0t] %0s", $time, label);
      end
    end
  endtask

  task automatic do_write(input [1:0] sel, input [7:0] data, input integer start_width, input [1023:0] label);
    reg ok;
    begin
      repeat (5) @(posedge clk);
      slave_sel <= sel;
      tx_data <= data;
      pulse_start(start_width);
      wait_done_bounded(2500, label, ok);
      if (ok) begin
        @(posedge clk);
        check_target(sel, data, label);
      end
      // done must drop next cycle
      @(posedge clk);
      if (done) $display("FAIL [t=%0t] %0s: done not 1-cycle", $time, label);
    end
  endtask

  initial begin
    $dumpfile("tb_i2c_link_top_3slaves_edge.vcd");
    $dumpvars(0, tb_i2c_link_top_3slaves_edge);

    // Safety timeout
    fork
      begin
        #5000000;
        $display("FAIL [t=%0t] global timeout", $time);
        $finish;
      end
    join_none

    repeat (5) @(posedge clk);
    rst <= 1'b0;
    repeat (5) @(posedge clk);

    // basic for all slaves
    do_write(2'd0, 8'h00, 1, "S0 write 00");
    do_write(2'd1, 8'hFF, 1, "S1 write FF");
    do_write(2'd2, 8'hAA, 1, "S2 write AA");

    // start held high multiple cycles should still be one transaction
    do_write(2'd0, 8'h55, 3, "S0 start held high 3 cycles");

    // start asserted during busy ignored: issue second start immediately
    begin
      reg ok;
      integer done_pulses;
      slave_sel <= 2'd1;
      tx_data <= 8'hF1;
      pulse_start(1);
      wait (busy);
      // attempt re-start while busy
      @(negedge clk);
      start_write <= 1'b1;
      @(negedge clk);
      start_write <= 1'b0;

      done_pulses = 0;
      fork
        begin : count_done
          integer k;
          for (k=0; k<4000; k=k+1) begin
            @(posedge clk);
            if (done) done_pulses++;
          end
        end
        begin : main_wait
          wait_done_bounded(2500, "S1 start during busy", ok);
          repeat (300) @(posedge clk);
        end
      join

      if (!ok) ;
      else if (done_pulses != 1) $display("FAIL [t=%0t] S1 start during busy: done_pulses=%0d", $time, done_pulses);
      else if (slave1_rx_data !== 8'hF1) $display("FAIL [t=%0t] S1 start during busy: rx got=%0h exp=%0h", $time, slave1_rx_data, 8'hF1);
      else $display("PASS [t=%0t] S1 start during busy ignored", $time);
    end

    // back-to-back: start next cycle after done, different slave
    begin
      reg ok;
      slave_sel <= 2'd2;
      tx_data <= 8'h12;
      pulse_start(1);
      wait_done_bounded(2500, "BB first", ok);
      if (ok) begin
        @(negedge clk);
        slave_sel <= 2'd0;
        tx_data <= 8'h34;
        start_write <= 1'b1;
        @(negedge clk);
        start_write <= 1'b0;
        wait_done_bounded(2500, "BB second", ok);
        if (ok && slave0_rx_valid && slave0_rx_data===8'h34) $display("PASS [t=%0t] back-to-back across slaves", $time);
        else if (ok) $display("FAIL [t=%0t] back-to-back: expected s0=34 (v=%b d=%0h)", $time, slave0_rx_valid, slave0_rx_data);
      end
    end

    // mid-transaction reset: should abort and allow next transaction
    begin
      reg ok;
      slave_sel <= 2'd2;
      tx_data <= 8'h77;
      pulse_start(1);
      wait (busy);
      repeat(10) @(posedge clk);
      rst <= 1'b1;
      repeat(2) @(posedge clk);
      if (busy !== 1'b0) $display("FAIL [t=%0t] mid-reset: busy not low", $time);
      else $display("PASS [t=%0t] mid-reset aborts transaction", $time);
      rst <= 1'b0;
      repeat(10) @(posedge clk);
      do_write(2'd2, 8'h88, 1, "post-reset S2 write 88");
    end

    #200;
    $finish;
  end
endmodule
